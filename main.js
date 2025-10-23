const express = require('express');
const session = require('express-session');
const passport = require('passport');
const SteamStrategy = require('passport-steam').Strategy;
const dotenv = require('dotenv').config();
const jwt = require('jsonwebtoken');
const webSocket = require('ws');

const app = express();

// Replace with your server-side Steam Web API key
const STEAM_API_KEY = process.env.STEAM_API_KEY;
const SERVER_IP = process.env.SERVER_IP;
const SERVER_HTTP_PORT = process.env.SERVER_HTTP_PORT;
const SERVER_WS_PORT = process.env.SERVER_WS_PORT;
const activeTokens = new Map();

function authenticateToken(req, res, next){
    const authHeader = req.headers["authorization"];
    var token;
    if(authHeader){
        const parts = authHeader.split(' ');
        if (parts.length === 2 && parts[0] === "Bearer"){
            token = parts[1];
        }
    }

    if (!token){
        return res.status(401).json({error: "No token provided"})
    }

    jwt.verify(token, process.env.SESSION_SECRET, (err, payload) =>{
        if(err){
            return res.status(403).json({error: "Invalid or expired token"})
        }

        req.user = payload;
        next()
    })
}

// Passport + Steam OpenID
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(new SteamStrategy({
  returnURL: `http://${SERVER_IP}:${SERVER_HTTP_PORT}/auth/steam/return`,
  realm: `http://${SERVER_IP}:${SERVER_HTTP_PORT}/`,
  apiKey: STEAM_API_KEY // passport-steam needs apiKey to fetch profile, but not strictly required for steamid via OpenID
}, (identifier, profile, done) => {
  // profile contains steamid and other public info
  process.nextTick(() => done(null, profile));
}));

app.use(session({ secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: true }));
app.use(passport.initialize());
app.use(passport.session());

// Start Steam login
app.get('/auth/steam', passport.authenticate('steam'), (req, res) => {});

// Steam callback
app.get('/auth/steam/return',
  passport.authenticate('steam', { failureRedirect: '/' }),
  (req, res) => {
    // Successful auth
    const accessToken = jwt.sign({ steamid: req.user.id }, process.env.SESSION_SECRET, { expiresIn: '1h' });
    const refreshToken = jwt.sign({ steamid: req.user.id }, process.env.SESSION_SECRET, { expiresIn: '7d' });
    activeTokens.set(accessToken, req.user.id)
    console.log('Authenticated user:', req.user.id);
    res.redirect(`http://${SERVER_IP}:${SERVER_HTTP_PORT}/auth/steam/success?token=${accessToken}`);
  }
);

app.get('/app', (req, res) => {
  res.send('you can close this window now');
});

app.get('/auth/steam/success', (req, res) => {
  res.send('<h1>Login successful! You can close this window.</h1>');
});

// Protected endpoint: get owned games for the logged-in user (server calls Steam API)
app.get('/api/owned-games', authenticateToken, async (req, res) => {
  const authHeader = req.headers["authorization"];
  let token;

  if (authHeader) {
    const parts = authHeader.split(' ');
    if (parts.length === 2 && parts[0] === "Bearer") {
      token = parts[1];
    }
  }

  console.log("Authorization header:", authHeader);
  console.log("Extracted token:", token);

  const steamid = activeTokens.get(token);
  console.log("Resolved SteamID:", steamid);

  if (!steamid) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  const url = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${process.env.STEAM_API_KEY}&steamid=${steamid}&include_appinfo=true&include_played_free_games=true&include_free_sub=true`;
  console.log("Calling Steam API:", url);

    try {
        const r = await fetch(url);
        console.log("Steam API status:", r.status);

    if (!r.ok) {
        const text = await r.text();
        console.error("Steam API error response:", text);
        return res.status(500).json({ error: 'Steam API error' });
    }

    const data = await r.json();
    res.json(data.response || {});
  } catch (err) {
        console.error("Fetch failed:", err);
        res.status(500).json({ error: err.message });
    }
});

app.listen(SERVER_HTTP_PORT, '0.0.0.0', () => console.log('Server listening on 0.0.0.0:' + SERVER_HTTP_PORT));

// WebSocket server for real-time features (e.g., game recommendations)
const wss = new webSocket.Server({ port: SERVER_WS_PORT, host: '0.0.0.0' });

const state = {
    lobbies: new Map(), // lobbyId -> lobby
    clients: new Map()  // clientId -> { ws, info }
};

function broadcastAll(data) {
    const msg = JSON.stringify(data);
  
    state.clients.forEach(({ ws }, steamid) => {
        if (ws.readyState === webSocket.OPEN) {
            ws.send(msg, (err) => {
                if (err) console.error("Send error:", err);
                else console.log("Sent OK to:", steamid);
            });
        }
    });
}

function broadcastOthers(ws, data) {
    const msg = JSON.stringify(data);
  
    state.clients.forEach(({ ws: clientWs }, steamid) => {
        if (clientWs !== ws && clientWs.readyState === webSocket.OPEN) {
            clientWs.send(msg, (err) => {
                if (err) console.error("Send error:", err);
                else console.log("Sent OK to:", steamid);
            });
        }
    });
}

function handleCreateLobby(ws, payload) {
    const lobbyId = `lobby-${Date.now()}`;
    var lobbyName = payload.lobbyName || 'New Lobby';
    state.lobbies.set(lobbyId, { members: new Set([]), lobbyName: payload.lobbyName || 'New Lobby' });
    ws.send(JSON.stringify({ action: 'lobby_created', payload: { lobbyId, lobbyName  } }));
    console.log(`Lobby created: ${lobbyId} by ${ws.user.steamid} and name ${payload.lobbyName}`);

}

function handleJoinLobby(ws, payload) {
    const { lobbyId } = payload;
    const lobby = state.lobbies.get(lobbyId);

    if (lobby) {
        var username = state.clients.get(ws.user.steamid)?.info.username || 'Anonymous';
        var games = state.clients.get(ws.user.steamid).info.games;

        //lobby.members.add({ steamid: ws.user.steamid, username, games });
        lobby.members.add( { steamid: ws.user.steamid, userName: username});

        var lobbyName = lobby.lobbyName || 'New Lobby';
        var lobbyMembers = Array.from(lobby.members);

        ws.send(JSON.stringify({ action: 'lobby_joined', payload: { lobbyId, lobbyName, lobbyMembers} }));

        //console.log(`User ${ws.user.steamid} joined lobby ${lobbyId}`);

        broadcastOthers( ws,{ action: 'lobby_joined', payload: {lobbyId: lobbyId, userID: ws.user.steamid, info: {games} } });

        broadcastAll({action: 'lobby_update', payload: compareLobbysGames(lobbyId)});
    } else {
        ws.send(JSON.stringify({ action: 'error', payload: { message: 'Lobby not found' } }));
    }

}

function getLobbyClients(lobbyId) {
    const lobby = state.lobbies.get(lobbyId);
    if (!lobby) return [];
    return Array.from(lobby.members)
            .map(member => state.clients.get(member.steamid))
            .filter(Boolean);

}

function handleLeaveLobby(ws, payload) {
    const { lobbyId } = payload;
    const lobby = state.lobbies.get(lobbyId);

    console.log(lobby)
    //lobby && lobby.members.has(ws.user.steamid

    var memberToRemove = Array.from(lobby.members).find(m => m.steamid === ws.user.steamid);

    if (memberToRemove) {
        lobby.members.delete(memberToRemove);
        ws.send(JSON.stringify({ action: 'lobby_left', payload: { lobbyId } }));
        console.log(`User ${ws.user.steamid} left lobby ${lobbyId}`);
        broadcastAll({ action: 'lobby_left', payload: { lobbyId: lobbyId, userID: ws.user.steamid } });

        if (lobby.members.size === 0) {
            state.lobbies.delete(lobbyId);
            console.log(`Lobby ${lobbyId} deleted as it became empty`);
        }
    } else {
        ws.send(JSON.stringify({ action: 'error', payload: { message: 'Not in the specified lobby' } }));
    }
}

function handleSetUserData(ws, payload) {
    const client = state.clients.get(ws.user.steamid);
    if (client) {
        client.info.username = payload.username;
        client.info.games = payload.games;

        ws.send(JSON.stringify({ action: 'username_set', payload: { username: payload.username } }));
        //console.log(`User ${ws.user.steamid} set username to ${payload.username}`);
    } else {
        ws.send(JSON.stringify({ action: 'error', payload: { message: 'Client not found' } }));
    }
}

wss.on('connection', function connection(ws, req) {
    console.log('WebSocket connection established');
    
    const token = req.url.split('token=')[1];
    if (!token) {
        ws.close(1008, 'No token provided');
        return;
    }

    jwt.verify(token, process.env.SESSION_SECRET, (err, payload) => {
        if (err) {
            ws.close(1008, 'Invalid or expired token');
            return;
        }

        ws.user = payload;
        console.log('WebSocket authenticated user:', ws.user.steamid);
        //console.log(payload);   
        ws.send(JSON.stringify({ message: 'WebSocket connection authenticated', steamid: activeTokens.get(token) }));
        
        state.clients.set(ws.user.steamid, { ws, info: {} });
        ws.on('message', function incoming(rawMessage) {
            //console.log('received: %s', rawMessage);
            // Handle incoming messages (e.g., lobby actions, chat, etc.)
            let message;
            try {
                message = JSON.parse(rawMessage);
            } catch (err) {
                console.error('Invalid JSON:', rawMessage);
                return;
            }

            const { action, payload } = message;

            switch (action) {
                case 'create_lobby':
                    handleCreateLobby(ws, payload);
                    break;
                case 'join_lobby':
                    handleJoinLobby(ws, payload);
                    break;
                case 'leave_lobby':
                    handleLeaveLobby(ws, payload);
                    break;
                case 'set_user_data':
                    handleSetUserData(ws, payload);
                    break;
                default:
                    console.warn('Unknown action:', action);
            
            };
        });

        ws.on('close', () => {
            console.log('WebSocket connection closed for user:', ws.user.steamid);
            state.clients.delete(ws.user.steamid);
        });
        
    })
})


console.log('WebSocket server listening on :3001');

function compareLobbysGames(lobbyId){
    const lobby = state.lobbies.get(lobbyId);
    if (!lobby) return { steam: [], epic: [] };
    
    
    // Initialize common sets as null
    let commonSteamIds = null;
    let commonEpicNames = null;
    
    const lobbyMembers = Array.from(lobby.members)
        .map(member => state.clients.get(member.steamid))
        .filter(Boolean);

    if (lobbyMembers.length === 0) return { steam: [], epic: [] };



    // --- 1. Find common Steam games ---
    lobbyMembers.forEach(client => {
        const steamIds = (client.info.games.steamGames || []).map(g => g.steam_id);
        if (commonSteamIds === null) {
            commonSteamIds = new Set(steamIds);
        } else {
            commonSteamIds = new Set(steamIds.filter(id => commonSteamIds.has(id)));
        }
    });

    // --- 2. Find common Epic games ---
    lobbyMembers.forEach(client => {
        const epicNames = (client.info.games.epicGames || []).map(g => g.app_name);
        if (commonEpicNames === null) {
            commonEpicNames = new Set(epicNames);
        } else {
            commonEpicNames = new Set(epicNames.filter(name => commonEpicNames.has(name)));
        }
    });

    // --- 3. Build results including which clients have it installed ---
    const steamGames = [];
    if (commonSteamIds && commonSteamIds.size > 0) {
        commonSteamIds.forEach(gameId => {
            const owners = lobbyMembers.map(c => {
                const gameObj = (c.info.games.steamGames || []).find(g => g.steam_id === gameId);
                return {
                    steamid: c.ws.user.steamid,
                    username: c.info.username,
                    installed: !!gameObj && gameObj.is_installed === 1
                };
            });

            const exampleClient = lobbyMembers.find(c =>
                (c.info.games.steamGames || []).some(g => g.steam_id === gameId)
            );
            const game = exampleClient?.info.games.steamGames.find(g => g.steam_id === gameId);

            if (game) steamGames.push({ game, owners });
        });
    }

    const epicGames = [];
    if (commonEpicNames && commonEpicNames.size > 0) {
        commonEpicNames.forEach(appName => {
            const owners = lobbyMembers.map(c => {
                const gameObj = (c.info.games.epicGames || []).find(g => g.app_name === appName);
                return {
                    steamid: c.ws.user.steamid,
                    username: c.info.username,
                    installed: !!gameObj && gameObj.is_installed === 1
                };
            });

            const exampleClient = lobbyMembers.find(c =>
                (c.info.games.epicGames || []).some(g => g.app_name === appName)
            );
            const game = exampleClient?.info.games.epicGames.find(g => g.app_name === appName);

            if (game) epicGames.push({ game, owners });
        });
    }


    return { steam: steamGames, epic: epicGames };
}
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
  returnURL: 'http://localhost:3000/auth/steam/return',
  realm: 'http://localhost:3000/',
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
    res.redirect(`http://localhost:3000/auth/steam/success?token=${accessToken}`);
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

app.listen(3000, () => console.log('Server listening on :3000'));

// WebSocket server for real-time features (e.g., game recommendations)
const wss = new webSocket.Server({ port: 3001 });

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

function handleCreateLobby(ws, payload) {

    console.log(payload)

    const lobbyId = `lobby-${Date.now()}`;
    var lobbyName = payload.lobbyName || 'New Lobby';
    state.lobbies.set(lobbyId, { members: new Set([ws.user.steamid]), name: payload.lobbyname || 'New Lobby' });
    ws.send(JSON.stringify({ action: 'lobby_created', payload: { lobbyId, lobbyName  } }));
    console.log(`Lobby created: ${lobbyId} by ${ws.user.steamid} and name ${payload.lobbyName}`);

    payload.games.steamGames.forEach(game => {
        console.log(game);
    })

    
    //broadcastAll({ lobbies: Array.from(state.lobbies.entries()).map(([id, lobby]) => ({ id, members: Array.from(lobby.members) })) });
}

function handleJoinLobby(ws, payload) {
    const { lobbyId } = payload;
    const lobby = state.lobbies.get(lobbyId);

    if (lobby) {
        lobby.members.add(ws.user.steamid);
        ws.send(JSON.stringify({ action: 'lobby_joined', payload: { lobbyId,  } }));
        console.log(`User ${ws.user.steamid} joined lobby ${lobbyId}`);
        broadcastAll({ action: 'lobby_joined', payload: {lobbyId: lobbyId, userID: ws.user.steamid } });
    } else {
        ws.send(JSON.stringify({ action: 'error', payload: { message: 'Lobby not found' } }));
    }
}

function getLobbyClients(lobbyId) {
    const lobby = state.lobbies.get(lobbyId);
    if (!lobby) return [];
    return Array.from(lobby.members).map(steamid => state.clients.get(steamid)?.ws).filter(Boolean);
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
        console.log(payload);   
        ws.send(JSON.stringify({ message: 'WebSocket connection authenticated', steamid: activeTokens.get(token) }));
        
        state.clients.set(ws.user.steamid, { ws, info: {} });
        ws.on('message', function incoming(rawMessage) {
            console.log('received: %s', rawMessage);
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
                case 'chat_message':
                    handleChatMessage(ws, payload);
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
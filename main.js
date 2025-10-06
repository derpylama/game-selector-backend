const express = require('express');
const session = require('express-session');
const passport = require('passport');
const SteamStrategy = require('passport-steam').Strategy;
const dotenv = require('dotenv').config();
const jwt = require('jsonwebtoken');

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

  const url = `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${process.env.STEAM_API_KEY}&steamid=${steamid}&include_appinfo=true`;
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
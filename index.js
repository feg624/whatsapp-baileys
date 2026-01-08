require('dotenv').config()

const express = require('express')
const qrcode = require('qrcode')
const bodyParser = require('body-parser')

const passport = require('passport')
const GoogleStrategy = require('passport-google-oauth').OAuth2Strategy
const session = require('express-session');

const {
  default: makeWASocket,
  fetchLatestBaileysVersion,
  DisconnectReason,
  // useMultiFileAuthState,
} = require('@whiskeysockets/baileys')
const { useCloudflareR2AuthState } = require('./r2-auth-store')
// const fs = require('fs').promises
const Boom = require('@hapi/boom')
const P = require('pino')
const jwt = require('jsonwebtoken')

const app = express()
const port = 10000

app.use(bodyParser.json())
app.use(bodyParser.urlencoded({ extended: true }))

app.use(session({
  secret: 'your_secret_key',
  resave: false,
  saveUninitialized: false
}));
app.use(passport.initialize())
app.use(passport.session())

const emails = ['francoguidoli@gmail.com']

passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: `${process.env.BASE_URL}/auth/google/callback`,
  },
  function(accessToken, refreshToken, profile, done) {
    if (!emails.includes(profile.emails[0].value)) {
      return done(Boom.unauthorized('Email not authorized'));
    }
    return done(null, profile);
  }
));

passport.serializeUser(function(user, done) {
  done(null, user);
});

passport.deserializeUser(function(obj, done) {
  done(null, obj);
});

// Start the OAuth flow
app.get('/auth/google',
  passport.authenticate('google', {
    scope: ['profile', 'email'],
    prompt: 'select_account'
  })
)

app.get('/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);

    req.session.destroy((err) => {
      if (err) return next(err);

      res.clearCookie('connect.sid'); 

      res.redirect('/'); 
    });
  });
})

// Google redirects here after user logs in
app.get('/auth/google/callback', 
  passport.authenticate('google', { failureRedirect: '/login' }),
  (req, res) => {
    res.redirect('/'); // Successful login
  }
)

let sock = null
let qrImageData = '' // holds the base64 QR code
let isConnected = false

const delay = ms => new Promise(res => setTimeout(res, ms))

function authenticateJWT(req, res, next) {
  const authHeader = req.headers.authorization
  const token = authHeader && authHeader.split(' ')[1]

  if (!token) {
    return res.sendStatus(401) // Unauthorized
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, sub) => {
    if (err) {
      return res.sendStatus(403) // Forbidden
    }
    req.sub = sub // attach decoded payload
    next()
  })
}

const checkAuth = (req, res, next) => {
  if (req.isAuthenticated()) {
    return next();
  }

  res.redirect('/auth/google');
};

app.get('/', checkAuth, async (req, res) => {
  res.send('<h2>WhatsApp Baileys API is running!</h2><p>Use /generate-jwt to create a JWT token and access protected routes.</p>')
})

app.get('/health', async (req, res) => {
  res.send('UP')
})

app.post('/generate-jwt', async (req, res) => {
  const { secret, sub, exp } = req.body;

  jwt.sign({ sub }, secret, { expiresIn: exp }, (err, token) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to generate token', details: err.message })
    }
    res.json({ token })
  })
})

app.get('/qr', checkAuth, async (req, res) => {
  if (isConnected) {
    return res.send('<h2>✅ Already connected to WhatsApp!</h2>')
  }

  await startWhatsApp()
  await delay(5000)

  if (qrImageData) {
    res.send(`
      <h2>Scan the QR Code:</h2>
      <img src="${qrImageData}" />
    `)
  } else {
    res.send('<h2>⏳ Waiting for QR code...</h2>')
  }
})

// Send message to group
app.post('/send', authenticateJWT, async (req, res) => {
  if (!isConnected || !sock) {
    // return res.status(400).json({ error: 'Not connected to WhatsApp' })
    await startWhatsApp()
    await delay(5000)
    if (!isConnected || !sock) {
      return res.status(400).json({ error: 'Not connected to WhatsApp' })
    }
  }

  const { jid, message } = req.body

  if (!jid || !message) {
    return res.status(400).json({ error: 'Missing jid or message in request body' })
  }

  try {
    await sock.sendMessage(jid, { text: message })
    res.json({ success: true, sent: { jid, message } })
  } catch (err) {
    console.error('Error sending message:', err)
    res.status(500).json({ error: 'Failed to send message', details: err.message })
  } finally {
    await delay(5000)
    await sock.end()
  }
})

// WhatsApp + Baileys logic
async function startWhatsApp() {
  // const { state, saveCreds } = await useMultiFileAuthState('auth_info')
  const { state, saveCreds, clearCreds } = await useCloudflareR2AuthState()
  const { version } = await fetchLatestBaileysVersion()

  sock = makeWASocket({
    version,
    auth: state,
    logger: P({ level: 'silent' }),
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update
    // console.log(connection)
    // console.log((lastDisconnect?.error)?.output?.statusCode)

    if (qr) {
      // Convert QR to base64 image
      qrImageData = await qrcode.toDataURL(qr)
      console.log(`🔗 New QR generated. Open http://localhost:${port}/qr to scan.`)
    }

    if (connection === 'close') {
      sock = null
      isConnected = false
      qrImageData = ''
      console.log('✅ WhatsApp disconnected.')

      // console.log(lastDisconnect)

      const shouldReconnect = (lastDisconnect?.error)?.output?.statusCode === DisconnectReason.restartRequired
      if (shouldReconnect) {
        console.log('Should reconnect...')
        startWhatsApp()
      }

      if ((lastDisconnect?.error)?.output?.statusCode === DisconnectReason.loggedOut) {
        // await fs.rm('auth_info', {recursive: true, force: true})
        await clearCreds()
      }
    } else if (connection === 'open') {
      isConnected = true
      qrImageData = ''
      console.log('✅ WhatsApp connected.')
    }
  })
}

// startWhatsApp()

// Start Express server
app.listen(port, () => {
  console.log(`🚀 Express server running at http://localhost:${port}`)
})

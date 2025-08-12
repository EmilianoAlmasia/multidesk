// FORMA TRADICIONAL (sin destructuring) - para entender mejor

// 1. Importar módulos completos
const express = require('express');
const http = require('http');
const socketio = require('socket.io');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const rfb = require('rfb2');

// 2. Crear aplicación express
const app = express();

// 2.1. Sistema de autenticación en memoria
const users = new Map([
    ['admin', 'nikita37'] // usuario: admin, password: nikita37
]);
const sessions = new Map(); // sesiones activas

// 2.2. Configuración VNC
const VNC_PORT = 5900;
const PROJECT_NAME = 'multidesk';

// 2.3. Variables VNC
let vncClient = null;
let isVncConnected = false;
let connectedViewers = new Set();

// 3. Crear servidor HTTP (usando el módulo http completo)
const server = http.createServer(app);

// 4. Crear servidor Socket.io (usando el módulo socketio completo)
const io = new socketio.Server(server);

// 5. Configuración para Railway
const PORT = process.env.PORT || 3000;

// 6. Middleware
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true })); // Para formularios
app.use(express.json());
app.use(cookieParser());

// 6.1. Middleware de autenticación
function requireAuth(req, res, next) {
    const sessionId = req.cookies.session;
    if (sessionId && sessions.has(sessionId)) {
        req.user = sessions.get(sessionId);
        next();
    } else {
        res.redirect('/login');
    }
}

// 6.2. Generar ID de sesión
function generateSessionId() {
    return crypto.randomBytes(32).toString('hex');
}

// 7. Rutas de autenticación
app.get('/', (req, res) => {
    res.redirect('/login');
});

app.get('/login', (req, res) => {
    const error = req.query.error ? '<p style="color:red">Usuario o contraseña incorrectos</p>' : '';
    res.send(`
        <html>
        <head><title>MultiDesk - Login</title></head>
        <body style="font-family: Arial; max-width: 400px; margin: 100px auto; padding: 20px;">
            <h1>MultiDesk</h1>
            <h2>Acceso al Escritorio Remoto</h2>
            ${error}
            <form method="POST" action="/login">
                <div style="margin: 10px 0;">
                    <label>Usuario:</label><br>
                    <input type="text" name="username" required style="width: 100%; padding: 8px;">
                </div>
                <div style="margin: 10px 0;">
                    <label>Contraseña:</label><br>
                    <input type="password" name="password" required style="width: 100%; padding: 8px;">
                </div>
                <button type="submit" style="width: 100%; padding: 10px; background: #007cba; color: white; border: none; cursor: pointer;">Ingresar</button>
            </form>
            <hr>
            <p><small>Puerto VNC: ${VNC_PORT} | Proyecto: ${PROJECT_NAME}</small></p>
        </body>
        </html>
    `);
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    
    if (users.has(username) && users.get(username) === password) {
        const sessionId = generateSessionId();
        sessions.set(sessionId, {
            username,
            loginTime: new Date(),
            ip: req.ip
        });
        
        res.cookie('session', sessionId, { 
            httpOnly: true,
            maxAge: 24 * 60 * 60 * 1000 // 24 horas
        });
        
        console.log(`🔐 Login exitoso: ${username} desde ${req.ip}`);
        res.redirect('/viewer');
    } else {
        console.log(`❌ Login fallido: ${username} desde ${req.ip}`);
        res.redirect('/login?error=1');
    }
});

app.get('/logout', (req, res) => {
    const sessionId = req.cookies.session;
    if (sessionId) {
        sessions.delete(sessionId);
    }
    res.clearCookie('session');
    res.redirect('/login');
});

// 7.1. Ruta protegida del viewer
app.get('/viewer', requireAuth, (req, res) => {
    res.send(`
        <html>
        <head><title>MultiDesk - Viewer</title></head>
        <body style="font-family: Arial; margin: 0; padding: 20px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                <h1>MultiDesk - Escritorio Remoto</h1>
                <div>
                    <span>Conectado como: <strong>${req.user.username}</strong></span>
                    <a href="/logout" style="margin-left: 20px; color: red;">Salir</a>
                </div>
            </div>
            
            <div id="status" style="padding: 10px; background: #f0f0f0; margin-bottom: 20px;">
                Estado: Esperando conexión VNC...
            </div>
            
            <div style="border: 2px solid #ccc; background: #000;">
                <canvas id="screen" style="display: block; max-width: 100%; height: auto;"></canvas>
            </div>
            
            <script src="/socket.io/socket.io.js"></script>
            <script>
                const socket = io();
                const canvas = document.getElementById('screen');
                const ctx = canvas.getContext('2d');
                const status = document.getElementById('status');
                
                socket.on('connect', () => {
                    status.textContent = 'Estado: Conectado al servidor, esperando VNC...';
                    socket.emit('viewer-ready');
                });
                
                socket.on('vnc-connected', () => {
                    status.textContent = 'Estado: VNC conectado - Mostrando escritorio remoto';
                });
                
                socket.on('vnc-disconnected', () => {
                    status.textContent = 'Estado: VNC desconectado';
                });
                
                socket.on('screen-update', (imageData) => {
                    const img = new Image();
                    img.onload = () => {
                        canvas.width = img.width;
                        canvas.height = img.height;
                        ctx.drawImage(img, 0, 0);
                    };
                    img.src = 'data:image/png;base64,' + imageData;
                });
                
                // Enviar eventos de mouse al servidor
                canvas.onclick = (e) => {
                    const rect = canvas.getBoundingClientRect();
                    const x = Math.floor((e.clientX - rect.left) * (canvas.width / rect.width));
                    const y = Math.floor((e.clientY - rect.top) * (canvas.height / rect.height));
                    socket.emit('mouse-click', { x, y, button: 1 });
                };
            </script>
        </body>
        </html>
    `);
});

// 8. Manejar conexiones WebSocket
io.on('connection', (socket) => {
    console.log('✅ Usuario conectado:', socket.id);
    
    socket.on('viewer-ready', () => {
        connectedViewers.add(socket.id);
        console.log(`👁️  Viewer agregado: ${socket.id}. Total viewers: ${connectedViewers.size}`);
        
        // Informar estado VNC actual
        if (isVncConnected) {
            socket.emit('vnc-connected');
        } else {
            socket.emit('vnc-disconnected');
        }
    });
    
    socket.on('mouse-click', (data) => {
        if (vncClient && isVncConnected) {
            console.log(`🖱️  Click recibido: x=${data.x}, y=${data.y}, button=${data.button}`);
            try {
                vncClient.sendPointer(data.x, data.y, data.button);
            } catch (error) {
                console.error('Error enviando click al VNC:', error);
            }
        }
    });
    
    socket.on('disconnect', (reason) => {
        connectedViewers.delete(socket.id);
        console.log('❌ Usuario desconectado:', socket.id, 'Razón:', reason);
        console.log(`👁️  Viewers restantes: ${connectedViewers.size}`);
    });
});

// 8.1. Funciones VNC
function connectToVNC() {
    if (vncClient) {
        console.log('🔄 Cerrando conexión VNC existente...');
        vncClient.end();
    }
    
    console.log(`🔌 Intentando conectar a VNC en puerto ${VNC_PORT}...`);
    
    vncClient = rfb.createConnection({
        host: '0.0.0.0',  // Escuchar conexiones entrantes
        port: VNC_PORT,
        password: '', // Sin password por ahora
        securityType: 'none'
    });
    
    vncClient.on('connect', () => {
        console.log('🎉 ¡Conexión VNC establecida!');
        isVncConnected = true;
        
        // Notificar a todos los viewers
        io.emit('vnc-connected');
        
        console.log(`📺 Resolución: ${vncClient.width}x${vncClient.height}`);
    });
    
    vncClient.on('rect', (rect) => {
        // Convertir el rectangulo a imagen base64 y enviarlo a viewers
        if (connectedViewers.size > 0) {
            try {
                const imageData = Buffer.from(rect.buffer).toString('base64');
                io.emit('screen-update', imageData);
            } catch (error) {
                console.error('Error procesando frame VNC:', error);
            }
        }
    });
    
    vncClient.on('close', () => {
        console.log('🔌 Conexión VNC cerrada');
        isVncConnected = false;
        io.emit('vnc-disconnected');
    });
    
    vncClient.on('error', (error) => {
        console.error('❌ Error VNC:', error.message);
        isVncConnected = false;
        io.emit('vnc-disconnected');
        
        // Reintentar conexión en 5 segundos
        setTimeout(() => {
            console.log('🔄 Reintentando conexión VNC...');
            connectToVNC();
        }, 5000);
    });
}

// 8.2. Iniciar servidor VNC cuando hay viewers
function checkAndStartVNC() {
    if (connectedViewers.size > 0 && !isVncConnected && !vncClient) {
        console.log('🚀 Iniciando conexión VNC...');
        connectToVNC();
    }
}

// 9. Iniciar el servidor
server.listen(PORT, () => {
    console.log(`🚀 Servidor MultiDesk ejecutándose en puerto ${PORT}`);
    console.log(`🌐 Web: http://localhost:${PORT}`);
    console.log(`🔌 VNC: Esperando conexión en puerto ${VNC_PORT}`);
    console.log(`👤 Login: admin / nikita37`);
    console.log(`📡 Proyecto: ${PROJECT_NAME}`);
    
    // Intentar conexión VNC inicial (opcional)
    // connectToVNC();
});
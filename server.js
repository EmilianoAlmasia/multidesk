// MultiDesk - Servidor Node.js como VNC Client con Web Interface
// Arquitectura: Node.js se conecta como cliente VNC y retransmite a web

// 1. Importar módulos
const express = require('express');
const http = require('http');
const socketio = require('socket.io');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const VncClient = require('vnc-rfb-client');

// 2. Configuración
const app = express();
const server = http.createServer(app);
const io = new socketio.Server(server);

// 2.1. Detectar entorno Railway
const IS_RAILWAY = process.env.RAILWAY_ENVIRONMENT_NAME !== undefined;

// 2.2. Configuración de puertos
const WEB_PORT = IS_RAILWAY ? 8080 : (process.env.PORT || 3000);
const PROJECT_NAME = 'multidesk';

// 2.3. Configuración Railway
const RAILWAY_DOMAIN = process.env.RAILWAY_PUBLIC_DOMAIN || 'multidesk-production.up.railway.app';

// 2.4. Configuración VNC Target (servidor al que nos conectaremos)
const VNC_TARGET = {
    host: process.env.VNC_HOST || '127.0.0.1',        // IP del TightVNC Server
    port: parseInt(process.env.VNC_PORT) || 5900,     // Puerto VNC
    password: process.env.VNC_PASSWORD || 'admin123'   // Password del VNC Server
};

// 2.5. Sistema de autenticación web
const users = new Map([
    ['admin', 'nikita37']
]);
const sessions = new Map();

// 2.6. Estado del cliente VNC
let vncClient = null;
let isVncConnected = false;
let webViewers = new Set();
let currentFrame = null;
let vncInfo = {
    width: 0,
    height: 0,
    connected: false
};

// 3. Middleware Express
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());

function requireAuth(req, res, next) {
    const sessionId = req.cookies.session;
    if (sessionId && sessions.has(sessionId)) {
        req.user = sessions.get(sessionId);
        next();
    } else {
        res.redirect('/login');
    }
}

function generateSessionId() {
    return crypto.randomBytes(32).toString('hex');
}

// 4. Rutas web
app.get('/', (req, res) => res.redirect('/login'));

app.get('/login', (req, res) => {
    const error = req.query.error ? '<p style="color:red">Usuario o contraseña incorrectos</p>' : '';
    res.send(`
        <html>
        <head><title>MultiDesk VNC - Login</title></head>
        <body style="font-family: Arial; max-width: 400px; margin: 100px auto; padding: 20px;">
            <h1>🖥️ MultiDesk VNC Client</h1>
            <h2>Control Remoto via Web</h2>
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
            <p><small>Target VNC: ${VNC_TARGET.host}:${VNC_TARGET.port} | Proyecto: ${PROJECT_NAME}</small></p>
            <p><small>Estado VNC: <span style="color: ${isVncConnected ? 'green' : 'red'}">${isVncConnected ? 'Conectado' : 'Desconectado'}</span></small></p>
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
            maxAge: 24 * 60 * 60 * 1000
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
    if (sessionId) sessions.delete(sessionId);
    res.clearCookie('session');
    res.redirect('/login');
});

app.get('/viewer', requireAuth, (req, res) => {
    res.send(`
        <html>
        <head><title>MultiDesk VNC - Remote Control</title></head>
        <body style="font-family: Arial; margin: 0; padding: 20px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                <h1>🖥️ MultiDesk VNC Client</h1>
                <div>
                    <span>Usuario: <strong>${req.user.username}</strong></span>
                    <a href="/logout" style="margin-left: 20px; color: red;">Salir</a>
                </div>
            </div>
            
            <div id="status" style="padding: 10px; background: #f0f0f0; margin-bottom: 20px;">
                Estado: Conectando...
            </div>
            
            <div id="vnc-info" style="margin-bottom: 10px;">
                <strong>VNC Target:</strong> ${VNC_TARGET.host}:${VNC_TARGET.port}<br>
                <strong>Estado:</strong> <span id="connection-status">${isVncConnected ? 'Conectado' : 'Intentando conectar...'}</span><br>
                ${IS_RAILWAY ? '<small>⚡ Ejecutándose en Railway</small>' : '<small>🏠 Ejecutándose localmente</small>'}
            </div>
            
            <div style="border: 2px solid #ccc; background: #000; position: relative;">
                <canvas id="screen" style="display: none; max-width: 100%; height: auto; cursor: crosshair;"></canvas>
                <div id="no-vnc" style="color: white; text-align: center; padding: 50px;">
                    ${isVncConnected ? 'Cargando escritorio...' : 'Conectando a VNC Server...'}
                </div>
            </div>
            
            <div id="controls" style="margin-top: 10px;">
                <button onclick="reconnectVnc()">Reconectar VNC</button>
                <button onclick="sendTestClick()">Test Click</button>
                <button onclick="sendTestKey()">Test Key (A)</button>
                <span id="mouse-pos" style="margin-left: 20px;"></span>
            </div>
            
            <script src="/socket.io/socket.io.js"></script>
            <script>
                const socket = io();
                const canvas = document.getElementById('screen');
                const ctx = canvas.getContext('2d');
                const status = document.getElementById('status');
                const noVnc = document.getElementById('no-vnc');
                const connectionStatus = document.getElementById('connection-status');
                
                socket.on('connect', () => {
                    status.textContent = 'Estado: Conectado al servidor web';
                });
                
                socket.on('vnc-connected', (info) => {
                    connectionStatus.textContent = 'Conectado';
                    status.textContent = \`Estado: VNC conectado (\${info.width}x\${info.height})\`;
                    canvas.width = info.width;
                    canvas.height = info.height;
                    noVnc.style.display = 'none';
                    canvas.style.display = 'block';
                });
                
                socket.on('vnc-disconnected', () => {
                    connectionStatus.textContent = 'Desconectado';
                    status.textContent = 'Estado: VNC desconectado';
                    noVnc.style.display = 'block';
                    canvas.style.display = 'none';
                    noVnc.textContent = 'VNC desconectado. Intentando reconectar...';
                });
                
                socket.on('vnc-frame', (frameData) => {
                    const img = new Image();
                    img.onload = () => {
                        ctx.clearRect(0, 0, canvas.width, canvas.height);
                        ctx.drawImage(img, 0, 0);
                    };
                    img.src = 'data:image/png;base64,' + frameData;
                });
                
                socket.on('vnc-error', (error) => {
                    status.textContent = \`Error VNC: \${error}\`;
                    connectionStatus.textContent = 'Error';
                });
                
                // Control de mouse sobre canvas
                canvas.addEventListener('mousemove', (e) => {
                    const rect = canvas.getBoundingClientRect();
                    const x = Math.floor((e.clientX - rect.left) * (canvas.width / rect.width));
                    const y = Math.floor((e.clientY - rect.top) * (canvas.height / rect.height));
                    
                    socket.emit('vnc-pointer-event', { x, y, buttons: 0 });
                    document.getElementById('mouse-pos').textContent = \`Mouse: \${x},\${y}\`;
                });
                
                canvas.addEventListener('mousedown', (e) => {
                    const rect = canvas.getBoundingClientRect();
                    const x = Math.floor((e.clientX - rect.left) * (canvas.width / rect.width));
                    const y = Math.floor((e.clientY - rect.top) * (canvas.height / rect.height));
                    
                    socket.emit('vnc-pointer-event', { x, y, buttons: 1 });
                });
                
                canvas.addEventListener('mouseup', (e) => {
                    const rect = canvas.getBoundingClientRect();
                    const x = Math.floor((e.clientX - rect.left) * (canvas.width / rect.width));
                    const y = Math.floor((e.clientY - rect.top) * (canvas.height / rect.height));
                    
                    socket.emit('vnc-pointer-event', { x, y, buttons: 0 });
                });
                
                // Control de teclado
                document.addEventListener('keydown', (e) => {
                    if (document.activeElement === canvas || e.target === canvas) {
                        e.preventDefault();
                        socket.emit('vnc-key-event', { key: e.keyCode, down: true });
                    }
                });
                
                document.addEventListener('keyup', (e) => {
                    if (document.activeElement === canvas || e.target === canvas) {
                        e.preventDefault();
                        socket.emit('vnc-key-event', { key: e.keyCode, down: false });
                    }
                });
                
                function reconnectVnc() {
                    socket.emit('reconnect-vnc');
                }
                
                function sendTestClick() {
                    socket.emit('vnc-pointer-event', { x: 100, y: 100, buttons: 1 });
                    setTimeout(() => {
                        socket.emit('vnc-pointer-event', { x: 100, y: 100, buttons: 0 });
                    }, 100);
                }
                
                function sendTestKey() {
                    socket.emit('vnc-key-event', { key: 65, down: true }); // A
                    setTimeout(() => {
                        socket.emit('vnc-key-event', { key: 65, down: false });
                    }, 100);
                }
                
                // Focus en canvas para capturar teclado
                canvas.setAttribute('tabindex', '0');
                canvas.focus();
            </script>
        </body>
        </html>
    `);
});

// 5. Funciones VNC Client
function connectToVnc() {
    if (vncClient) {
        try {
            vncClient.disconnect();
        } catch (e) {
            console.log('🔧 Limpiando conexión anterior');
        }
    }
    
    console.log(`🔌 Conectando a VNC Server: ${VNC_TARGET.host}:${VNC_TARGET.port}`);
    
    vncClient = new VncClient({
        debug: false,
        encodings: [
            VncClient.consts.encodings.raw,
            VncClient.consts.encodings.copyRect,
            VncClient.consts.encodings.hextile,
            VncClient.consts.encodings.zrle,
            VncClient.consts.encodings.pseudoDesktopSize,
            VncClient.consts.encodings.pseudoCursor
        ]
    });
    
    // Eventos del cliente VNC
    vncClient.on('connected', () => {
        console.log('✅ VNC conectado exitosamente');
        isVncConnected = true;
        io.emit('vnc-connected', vncInfo);
    });
    
    vncClient.on('disconnected', () => {
        console.log('❌ VNC desconectado');
        isVncConnected = false;
        io.emit('vnc-disconnected');
        
        // Reconectar automáticamente después de 5 segundos
        setTimeout(() => {
            console.log('🔄 Reintentando conexión VNC...');
            connectToVnc();
        }, 5000);
    });
    
    vncClient.on('connectError', (err) => {
        console.error('❌ Error conectando VNC:', err.message);
        isVncConnected = false;
        io.emit('vnc-error', err.message);
    });
    
    vncClient.on('authError', (err) => {
        console.error('🔐 Error de autenticación VNC:', err.message);
        io.emit('vnc-error', `Autenticación: ${err.message}`);
    });
    
    vncClient.on('firstFrameUpdate', (fb) => {
        console.log(`🖥️ Primer frame recibido: ${fb.width}x${fb.height}`);
        vncInfo = {
            width: fb.width,
            height: fb.height,
            connected: true
        };
        
        // Enviar frame como PNG base64
        const frameBuffer = fb.buffer;
        const frameBase64 = frameBuffer.toString('base64');
        currentFrame = frameBuffer;
        
        io.emit('vnc-frame', frameBase64);
    });
    
    vncClient.on('frameUpdate', (fb) => {
        // Actualización de frame
        const frameBuffer = fb.buffer;
        const frameBase64 = frameBuffer.toString('base64');
        currentFrame = frameBuffer;
        
        io.emit('vnc-frame', frameBase64);
    });
    
    // Conectar al servidor VNC
    vncClient.connect({
        host: VNC_TARGET.host,
        port: VNC_TARGET.port,
        password: VNC_TARGET.password
    });
}

// 6. Socket.io para control web
io.on('connection', (socket) => {
    console.log(`🌐 Viewer web conectado: ${socket.id}`);
    webViewers.add(socket.id);
    
    // Enviar estado actual
    if (isVncConnected) {
        socket.emit('vnc-connected', vncInfo);
        if (currentFrame) {
            socket.emit('vnc-frame', currentFrame.toString('base64'));
        }
    }
    
    socket.on('disconnect', () => {
        webViewers.delete(socket.id);
        console.log(`🌐 Viewer web desconectado: ${socket.id}`);
    });
    
    // Eventos de control remoto
    socket.on('vnc-pointer-event', (data) => {
        if (vncClient && isVncConnected) {
            vncClient.sendPointerEvent(data.x, data.y, data.buttons);
        }
    });
    
    socket.on('vnc-key-event', (data) => {
        if (vncClient && isVncConnected) {
            vncClient.sendKeyEvent(data.key, data.down);
        }
    });
    
    socket.on('reconnect-vnc', () => {
        console.log('🔄 Reconexión VNC solicitada desde web');
        connectToVnc();
    });
});

// 7. Iniciar servidor web
server.listen(WEB_PORT, '0.0.0.0', () => {
    console.log(`🚀 MultiDesk VNC Client iniciado`);
    console.log(`🌐 Web Interface: ${IS_RAILWAY ? `https://${RAILWAY_DOMAIN}` : `http://localhost:${WEB_PORT}`}`);
    console.log(`👤 Login: admin / nikita37`);
    console.log(`🎯 VNC Target: ${VNC_TARGET.host}:${VNC_TARGET.port}`);
    console.log(`📡 Proyecto: ${PROJECT_NAME}`);
    
    // Iniciar conexión VNC
    setTimeout(() => {
        connectToVnc();
    }, 2000);
});

// Manejo de errores
process.on('uncaughtException', (err) => {
    console.error('❌ Error no capturado:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Promesa rechazada:', reason);
});

// Cleanup al salir
process.on('SIGINT', () => {
    console.log('🛑 Cerrando servidor...');
    if (vncClient) {
        vncClient.disconnect();
    }
    process.exit(0);
});
// MultiDesk - Servidor VNC Real con Web Interface
// Basado en rfb2 server implementation

// 1. Importar módulos
const express = require('express');
const http = require('http');
const socketio = require('socket.io');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const net = require('net');
const util = require('util');
const PackStream = require('./node_modules/rfb2/unpackstream');
const EventEmitter = require('events').EventEmitter;
const rfb = require('./node_modules/rfb2/constants');

// 2. Configuración
const app = express();
const server = http.createServer(app);
const io = new socketio.Server(server);

// 2.1. Configuración de puertos
const WEB_PORT = process.env.PORT || 3000;
const VNC_PORT = process.env.VNC_PORT || 5901; // Puerto interno VNC (diferente de 5900)
const PROJECT_NAME = 'multidesk';

// 2.1.1. Detectar entorno Railway
const IS_RAILWAY = process.env.RAILWAY_ENVIRONMENT_NAME !== undefined;
const VNC_EXTERNAL_INFO = IS_RAILWAY ? 
    'turntable.proxy.rlwy.net:54765 (Railway TCP Proxy)' : 
    `localhost:${VNC_PORT}`;

// 2.2. Sistema de autenticación web
const users = new Map([
    ['admin', 'nikita37']
]);
const sessions = new Map();

// 2.3. Estado del servidor VNC
let vncClients = new Map(); // Almacenar clientes VNC conectados
let webViewers = new Set(); // Almacenar viewers web conectados
let currentFrame = null; // Frame actual para nuevos viewers

// 3. Clase RfbServer (basada en rfb2/rfbserver.js)
function RfbServer(stream, clientId) {
    EventEmitter.call(this);
    this.clientId = clientId;
    this.stream = stream;
    this.pack_stream = new PackStream();
    this.width = 1024;
    this.height = 768;
    this.title = `MultiDesk-${clientId}`;
    
    var serv = this;
    
    // Configurar streams
    serv.pack_stream.on('data', function(data) {
        serv.stream.write(data);
    });
    
    stream.on('data', function(data) {
        serv.pack_stream.write(data);
    });
    
    stream.on('close', function() {
        console.log(`🔌 Cliente VNC ${clientId} desconectado`);
        vncClients.delete(clientId);
        serv.emit('disconnected');
        // Notificar a viewers web
        io.emit('vnc-client-disconnected', clientId);
    });
    
    // Iniciar handshake VNC
    serv.writeServerVersion();
}

util.inherits(RfbServer, EventEmitter);

// 3.1. Implementar protocolo VNC
RfbServer.prototype.writeServerVersion = function() {
    console.log(`📋 Iniciando handshake VNC para cliente ${this.clientId}`);
    var serv = this;
    this.stream.write(rfb.versionstring.V3_008);
    this.pack_stream.get(12, function(buf) {
        console.log(`✅ Cliente ${serv.clientId} versión:`, buf.toString('ascii').trim());
        serv.writeSecurityTypes();
    });
};

RfbServer.prototype.writeSecurityTypes = function() {
    var serv = this;
    // Usar seguridad None para simplificar
    serv.pack_stream.pack('CC', [1, rfb.security.None]);
    serv.pack_stream.flush();
    
    serv.pack_stream.unpack('C', function(cliSecType) {
        console.log(`🔐 Cliente ${serv.clientId} eligió seguridad:`, cliSecType[0]);
        serv.processSecurity(cliSecType[0]);
    });
};

RfbServer.prototype.processSecurity = function(securityType) {
    var serv = this;
    // Enviar resultado de seguridad OK
    serv.pack_stream.pack('L', [0]).flush();
    serv.readClientInit();
};

RfbServer.prototype.readClientInit = function() {
    var serv = this;
    serv.pack_stream.unpack('C', function(isShared) {
        console.log(`🤝 Cliente ${serv.clientId} shared:`, isShared[0]);
        serv.writeServerInit();
    });
};

RfbServer.prototype.writeServerInit = function() {
    var serv = this;
    serv.pack_stream.pack('SSCCCCSSSCCCxxxLa', [
        serv.width,  // ancho
        serv.height, // alto
        32,          // bits por pixel
        24,          // profundidad
        0,           // big endian
        1,           // true color
        255,         // red max
        255,         // green max  
        255,         // blue max
        16,          // red shift
        8,           // green shift
        0,           // blue shift
        serv.title.length,
        serv.title
    ]);
    serv.pack_stream.flush();
    
    console.log(`🖥️  Cliente ${serv.clientId} inicializado: ${serv.width}x${serv.height}`);
    
    // Notificar a viewers web que hay cliente VNC
    io.emit('vnc-client-connected', {
        clientId: serv.clientId,
        width: serv.width,
        height: serv.height,
        title: serv.title
    });
    
    serv.expectMessage();
};

RfbServer.prototype.expectMessage = function() {
    var serv = this;
    serv.pack_stream.get(1, function(msgType) {
        switch(msgType[0]) {
            case rfb.clientMsgTypes.fbUpdate:
                var updateRequest = {};
                serv.pack_stream.unpackTo(updateRequest, [
                    'C incremental',
                    'S x',
                    'S y', 
                    'S width',
                    'S height'
                ], function() {
                    console.log(`🖼️  Cliente ${serv.clientId} solicita frame:`, updateRequest);
                    serv.sendTestFrame(updateRequest);
                    serv.expectMessage();
                });
                break;
                
            case rfb.clientMsgTypes.setEncodings:
                serv.pack_stream.unpack('xS', function(numEnc) {
                    serv.pack_stream.unpack('L'.repeat(numEnc[0]), function(encodings) {
                        console.log(`🎨 Cliente ${serv.clientId} encodings:`, encodings);
                        serv.expectMessage();
                    });
                });
                break;
                
            case rfb.clientMsgTypes.pointerEvent:
                serv.pack_stream.unpack('CSS', function(res) {
                    var pointerEvent = {
                        clientId: serv.clientId,
                        buttons: res[0],
                        x: res[1],
                        y: res[2]
                    };
                    console.log(`🖱️  Cliente ${serv.clientId} pointer:`, pointerEvent);
                    
                    // Reenviar a viewers web
                    io.emit('vnc-pointer-event', pointerEvent);
                    
                    serv.expectMessage();
                });
                break;
                
            case rfb.clientMsgTypes.keyEvent:
                serv.pack_stream.unpack('CxxL', function(res) {
                    var keyEvent = {
                        clientId: serv.clientId,
                        isDown: res[0],
                        keysym: res[1]
                    };
                    console.log(`⌨️  Cliente ${serv.clientId} key:`, keyEvent);
                    
                    // Reenviar a viewers web  
                    io.emit('vnc-key-event', keyEvent);
                    
                    serv.expectMessage();
                });
                break;
                
            default:
                console.log(`❓ Cliente ${serv.clientId} mensaje desconocido:`, msgType[0]);
                serv.expectMessage();
        }
    });
};

// 3.2. Enviar frame de prueba
RfbServer.prototype.sendTestFrame = function(updateRequest) {
    var serv = this;
    
    // Crear frame de prueba (pantalla azul con texto)
    var frameData = Buffer.alloc(serv.width * serv.height * 4);
    
    // Llenar con color azul (BGRA format)
    for (let i = 0; i < frameData.length; i += 4) {
        frameData[i] = 255;     // Blue
        frameData[i + 1] = 0;   // Green  
        frameData[i + 2] = 0;   // Red
        frameData[i + 3] = 255; // Alpha
    }
    
    // Enviar FramebufferUpdate
    serv.pack_stream.pack('CSS', [
        0,  // message type: FramebufferUpdate
        0,  // padding
        1   // number of rectangles
    ]);
    
    // Rectangle header
    serv.pack_stream.pack('SSSSL', [
        0,           // x
        0,           // y  
        serv.width,  // width
        serv.height, // height
        0            // encoding: Raw
    ]);
    
    // Pixel data
    serv.pack_stream.pack('a', [frameData]);
    serv.pack_stream.flush();
    
    // Enviar frame a viewers web también
    var frameBase64 = frameData.toString('base64');
    io.emit('vnc-frame-update', {
        clientId: serv.clientId,
        width: serv.width,
        height: serv.height,
        data: frameBase64
    });
    
    currentFrame = frameBase64;
};

// 4. Middleware Express
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

// 5. Rutas web
app.get('/', (req, res) => res.redirect('/login'));

app.get('/login', (req, res) => {
    const error = req.query.error ? '<p style="color:red">Usuario o contraseña incorrectos</p>' : '';
    res.send(`
        <html>
        <head><title>MultiDesk VNC - Login</title></head>
        <body style="font-family: Arial; max-width: 400px; margin: 100px auto; padding: 20px;">
            <h1>🖥️ MultiDesk VNC</h1>
            <h2>Servidor VNC Real</h2>
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
            <p><small>Clientes VNC conectados: <span id="vnc-count">${vncClients.size}</span></small></p>
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
        <head><title>MultiDesk VNC - Viewer</title></head>
        <body style="font-family: Arial; margin: 0; padding: 20px;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                <h1>🖥️ MultiDesk VNC Server</h1>
                <div>
                    <span>Usuario: <strong>${req.user.username}</strong></span>
                    <a href="/logout" style="margin-left: 20px; color: red;">Salir</a>
                </div>
            </div>
            
            <div id="status" style="padding: 10px; background: #f0f0f0; margin-bottom: 20px;">
                Estado: Conectando...
            </div>
            
            <div id="vnc-info" style="margin-bottom: 10px;">
                <strong>Instrucciones:</strong><br>
                1. Conecta tu cliente VNC a: <code>${VNC_EXTERNAL_INFO}</code><br>
                2. Una vez conectado, verás la pantalla aquí y podrás controlarla desde la web<br>
                ${IS_RAILWAY ? '<small>⚡ Ejecutándose en Railway</small>' : '<small>🏠 Ejecutándose localmente</small>'}
            </div>
            
            <div style="border: 2px solid #ccc; background: #000; position: relative;">
                <canvas id="screen" style="display: block; max-width: 100%; height: auto;"></canvas>
                <div id="no-vnc" style="color: white; text-align: center; padding: 50px;">
                    Esperando conexión de cliente VNC...
                </div>
            </div>
            
            <div id="controls" style="margin-top: 10px;">
                <button onclick="sendTestClick()">Test Click</button>
                <button onclick="sendTestKey()">Test Key</button>
                <span id="mouse-pos" style="margin-left: 20px;"></span>
            </div>
            
            <script src="/socket.io/socket.io.js"></script>
            <script>
                const socket = io();
                const canvas = document.getElementById('screen');
                const ctx = canvas.getContext('2d');
                const status = document.getElementById('status');
                const noVnc = document.getElementById('no-vnc');
                let currentClient = null;
                
                socket.on('connect', () => {
                    status.textContent = 'Estado: Conectado al servidor web';
                });
                
                socket.on('vnc-client-connected', (clientInfo) => {
                    currentClient = clientInfo.clientId;
                    status.textContent = \`Estado: Cliente VNC \${clientInfo.clientId} conectado (\${clientInfo.width}x\${clientInfo.height})\`;
                    canvas.width = clientInfo.width;
                    canvas.height = clientInfo.height;
                    noVnc.style.display = 'none';
                    canvas.style.display = 'block';
                });
                
                socket.on('vnc-client-disconnected', (clientId) => {
                    status.textContent = \`Estado: Cliente VNC \${clientId} desconectado\`;
                    currentClient = null;
                    noVnc.style.display = 'block';
                    canvas.style.display = 'none';
                });
                
                socket.on('vnc-frame-update', (frameData) => {
                    const img = new Image();
                    img.onload = () => {
                        ctx.clearRect(0, 0, canvas.width, canvas.height);
                        ctx.drawImage(img, 0, 0);
                    };
                    img.src = 'data:image/rgba;base64,' + frameData.data;
                });
                
                socket.on('vnc-pointer-event', (pointerEvent) => {
                    // Mostrar eventos de mouse del cliente VNC
                    document.getElementById('mouse-pos').textContent = 
                        \`VNC Mouse: \${pointerEvent.x},\${pointerEvent.y} buttons:\${pointerEvent.buttons}\`;
                });
                
                // Enviar eventos de mouse al servidor (para futuro control)
                canvas.addEventListener('mousemove', (e) => {
                    const rect = canvas.getBoundingClientRect();
                    const x = Math.floor((e.clientX - rect.left) * (canvas.width / rect.width));
                    const y = Math.floor((e.clientY - rect.top) * (canvas.height / rect.height));
                    document.getElementById('mouse-pos').textContent = \`Web Mouse: \${x},\${y}\`;
                });
                
                function sendTestClick() {
                    if (currentClient) {
                        socket.emit('web-to-vnc-pointer', {
                            clientId: currentClient,
                            x: 100,
                            y: 100,
                            buttons: 1
                        });
                    }
                }
                
                function sendTestKey() {
                    if (currentClient) {
                        socket.emit('web-to-vnc-key', {
                            clientId: currentClient,
                            keysym: 65, // 'A'
                            isDown: 1
                        });
                    }
                }
            </script>
        </body>
        </html>
    `);
});

// 6. Servidor VNC
const vncServer = net.createServer(function(conn) {
    const clientId = `client-${Date.now()}`;
    console.log(`🔗 Nueva conexión VNC: ${clientId} desde ${conn.remoteAddress}`);
    
    const rfbServer = new RfbServer(conn, clientId);
    vncClients.set(clientId, rfbServer);
    
    rfbServer.on('disconnected', () => {
        vncClients.delete(clientId);
    });
});

// 7. Socket.io para viewers web
io.on('connection', (socket) => {
    console.log(`🌐 Viewer web conectado: ${socket.id}`);
    webViewers.add(socket.id);
    
    socket.on('disconnect', () => {
        webViewers.delete(socket.id);
        console.log(`🌐 Viewer web desconectado: ${socket.id}`);
    });
});

// 8. Iniciar servidores
server.listen(WEB_PORT, () => {
    console.log(`🚀 MultiDesk VNC Server iniciado`);
    console.log(`🌐 Web Interface: http://localhost:${WEB_PORT}`);
    console.log(`👤 Login: admin / nikita37`);
    console.log(`📡 Proyecto: ${PROJECT_NAME}`);
});

vncServer.listen(VNC_PORT, (err) => {
    if (err) {
        console.error(`❌ Error iniciando servidor VNC en puerto ${VNC_PORT}:`, err.message);
        console.log(`🔄 Intentando puerto alternativo...`);
        
        // Intentar puerto alternativo
        const altPort = VNC_PORT + 1;
        vncServer.listen(altPort, (err2) => {
            if (err2) {
                console.error(`❌ Error en puerto alternativo ${altPort}:`, err2.message);
                process.exit(1);
            } else {
                console.log(`✅ Servidor VNC iniciado en puerto alternativo ${altPort}`);
                console.log(`📋 Conecta tu cliente VNC a: localhost:${altPort}`);
            }
        });
    } else {
        console.log(`🔌 Servidor VNC escuchando en puerto ${VNC_PORT}`);
        console.log(`📋 Conecta tu cliente VNC a: ${VNC_EXTERNAL_INFO}`);
        if (IS_RAILWAY) {
            console.log(`⚠️  IMPORTANTE: En Railway, configura TCP Proxy puerto 5900 → ${VNC_PORT}`);
        }
    }
});

// Manejo de errores
process.on('uncaughtException', (err) => {
    console.error('❌ Error no capturado:', err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Promesa rechazada:', reason);
});
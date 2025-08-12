# 🖥️ MultiDesk VNC Server

Sistema de escritorio remoto VNC con interface web. Permite conectar clientes VNC y visualizar/controlar desde navegador web con autenticación.

## 🚀 Características

- **Servidor VNC real** basado en protocolo RFB estándar
- **Interface web** para visualización y control remoto
- **Autenticación web** con sesiones
- **Compatible** con cualquier cliente VNC (TightVNC, RealVNC, UltraVNC)
- **Listo para Railway** deployment
- **Tiempo real** via WebSockets

## 📋 Requisitos

- Node.js 16+
- Cliente VNC (TightVNC, RealVNC, etc.)
- Navegador moderno

## 🛠️ Instalación Local

```bash
# Clonar repositorio
git clone https://github.com/EmilianoAlmasia/multidesk.git
cd multidesk

# Instalar dependencias
npm install

# Iniciar servidor
npm start
```

## 🌐 Uso

### 1. Iniciar el servidor
```bash
npm start
```

Verás:
```
🚀 MultiDesk VNC Server iniciado
🌐 Web Interface: http://localhost:3000
👤 Login: admin / nikita37
🔌 Servidor VNC escuchando en puerto 5900
```

### 2. Acceder via web
1. Abre: `http://localhost:3000`
2. Login: `admin` / `nikita37`
3. Verás instrucciones para conectar cliente VNC

### 3. Conectar cliente VNC
**Configuración:**
- **Host:** `localhost`
- **Puerto:** `5900`
- **Password:** Ninguno (seguridad: None)

**Clientes recomendados:**
- **Windows:** TightVNC Viewer, UltraVNC Viewer
- **Mac:** Built-in Screen Sharing, RealVNC Viewer  
- **Linux:** Remmina, Vinagre

### 4. Visualizar y controlar
Una vez conectado el cliente VNC:
- La pantalla aparecerá en el navegador web
- Podrás ver eventos de mouse/teclado en tiempo real
- Interfaz web mostrará estado de conexión

## 🚂 Deployment en Railway

### 1. Conectar GitHub a Railway
1. Ve a [railway.app](https://railway.app)
2. Login with GitHub
3. "New Project" → "Deploy from GitHub repo"
4. Selecciona: `EmilianoAlmasia/multidesk`

### 2. Configurar TCP Proxy
**En Railway Dashboard:**
1. Ve a tu proyecto → **Settings**
2. **Public Networking** → **TCP Proxy**
3. **Port:** `8080` (puerto interno libre)
4. **Protocol:** `TCP`
5. Railway te dará algo como: `gondola.proxy.rlwy.net:51365`

**⚠️ Importante:** El servidor usa puerto `8080` internamente para evitar conflictos en Railway.

### 3. Conexión VNC en Railway
**Tu cliente VNC se conecta a:**
```
Host: gondola.proxy.rlwy.net
Port: 51365
```

**Viewers web acceden a:**
```
https://multidesk-production.up.railway.app
Login: admin / nikita37
```

## 🔧 Configuración

### Variables de entorno
```env
PORT=3000          # Puerto web (Railway lo asigna automáticamente)
VNC_PORT=5900      # Puerto VNC (fijo)
```

### Cambiar credenciales
Edita en `server.js`:
```javascript
const users = new Map([
    ['admin', 'nikita37']     // Cambiar aquí
]);
```

## 📡 Arquitectura

```
┌─────────────────┐    VNC Protocol     ┌─────────────────┐
│   Cliente VNC   │◄────── TCP ────────►│  Railway Server │
│  (Tu escritorio)│     Puerto 5900     │   (Node.js)     │
└─────────────────┘                     └─────────────────┘
                                                 │
                                            WebSocket
                                                 ▼
                                        ┌─────────────────┐
                                        │   Web Viewers   │
                                        │   (Navegador)   │
                                        └─────────────────┘
```

**Flujo de datos:**
1. **Cliente VNC** envía pantalla → **Servidor** 
2. **Servidor** convierte frames VNC → **Web viewers**
3. **Web viewers** envían eventos mouse/teclado → **Servidor**
4. **Servidor** reenvía eventos → **Cliente VNC**

## 🐛 Troubleshooting

### Servidor no inicia
```bash
# Verificar puerto libre
netstat -ano | findstr :3000
netstat -ano | findstr :5900

# Matar procesos si es necesario
npx kill-port 3000
npx kill-port 5900
```

### Cliente VNC no conecta
1. **Verificar puerto:** `telnet localhost 5900`
2. **Firewall:** Asegurar que puerto 5900 esté abierto
3. **Cliente:** Usar seguridad "None" o sin password

### No aparece pantalla en web
1. **Verificar logs:** Buscar mensajes de conexión VNC
2. **Abrir developer tools:** Ver errores de WebSocket
3. **Refrescar página:** Después de conectar VNC

### Railway TCP Proxy
1. **Verificar configuración:** Settings → Public Networking
2. **Usar puerto asignado:** No 5900, sino el que Railway te da
3. **Logs Railway:** Ver errores de conexión

## 📚 Tecnologías

- **Backend:** Node.js, Express
- **VNC:** rfb2 (protocolo RFB)
- **WebSockets:** Socket.io
- **Frontend:** HTML5 Canvas, JavaScript
- **Deployment:** Railway

## 🤝 Contribuir

1. Fork el proyecto
2. Crea feature branch: `git checkout -b feature/nueva-funcionalidad`
3. Commit cambios: `git commit -m 'Agregar nueva funcionalidad'`
4. Push branch: `git push origin feature/nueva-funcionalidad`
5. Abrir Pull Request

## 📝 Licencia

ISC License

## 👨‍💻 Autor

MultiDesk Project

---

🤖 *Generated with [Claude Code](https://claude.ai/code)*
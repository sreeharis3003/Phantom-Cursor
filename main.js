// ─────────────────────────────────────────────────────────────
// main.js — Electron main process (Windows + macOS)
// Creates a frameless, transparent, always-on-top overlay window
// and spawns a local WebSocket relay server on port 8765.
// Supports remote click & keyboard simulation via koffi FFI.
// Supports screen mirroring via desktopCapturer.
// ─────────────────────────────────────────────────────────────

const { app, BrowserWindow, ipcMain, screen, desktopCapturer } = require('electron');
const path = require('path');
const os = require('os');
const { WebSocketServer, WebSocket } = require('ws');

let mainWindow = null;
let wss = null;
let isClickThrough = false;
let remoteClickEnabled = false;
let screenShareEnabled = false;

// ── Platform-abstracted input simulation ─────────────────────
let nativeReady = false;

// --- Windows ---
let win_SetCursorPos = null;
let win_mouse_event = null;
let win_keybd_event = null;
const MOUSEEVENTF_LEFTDOWN = 0x0002, MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_RIGHTDOWN = 0x0008, MOUSEEVENTF_RIGHTUP = 0x0010;
const KEYEVENTF_KEYUP = 0x0002, KEYEVENTF_EXTENDEDKEY = 0x0001;

// --- macOS ---
let mac_CGEventCreateMouseEvent = null;
let mac_CGEventCreateKeyboardEvent = null;
let mac_CGEventPost = null;
let mac_CFRelease = null;
// macOS CGEvent constants
const kCGEventLeftMouseDown = 1, kCGEventLeftMouseUp = 2;
const kCGEventRightMouseDown = 3, kCGEventRightMouseUp = 4;
const kCGHIDEventTap = 0;
const kCGMouseButtonLeft = 0, kCGMouseButtonRight = 1;

// ── Load native libraries per platform ──────────────────────
if (process.platform === 'win32') {
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    win_SetCursorPos = user32.func('bool __stdcall SetCursorPos(int x, int y)');
    win_mouse_event = user32.func('void __stdcall mouse_event(uint32 dwFlags, uint32 dx, uint32 dy, uint32 dwData, uintptr dwExtraInfo)');
    win_keybd_event = user32.func('void __stdcall keybd_event(uint8 bVk, uint8 bScan, uint32 dwFlags, uintptr dwExtraInfo)');
    nativeReady = true;
    console.log('[Native] Windows koffi loaded — remote input simulation available');
  } catch (err) {
    console.warn('[Native] Could not load koffi (Windows):', err.message);
  }
} else if (process.platform === 'darwin') {
  try {
    const koffi = require('koffi');
    const CGPoint = koffi.struct('CGPoint', { x: 'double', y: 'double' });
    const cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
    const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
    mac_CGEventCreateMouseEvent = cg.func('void* CGEventCreateMouseEvent(void* source, uint32 mouseType, CGPoint mouseCursorPosition, uint32 mouseButton)');
    mac_CGEventCreateKeyboardEvent = cg.func('void* CGEventCreateKeyboardEvent(void* source, uint16 virtualKey, bool keyDown)');
    mac_CGEventPost = cg.func('void CGEventPost(uint32 tap, void* event)');
    mac_CFRelease = cf.func('void CFRelease(void* cf)');
    nativeReady = true;
    console.log('[Native] macOS CoreGraphics loaded — remote input simulation available');
  } catch (err) {
    console.warn('[Native] Could not load CoreGraphics (macOS):', err.message);
  }
}

// ── Mouse Click Simulation ──────────────────────────────────
function simulateMouseClick(x, y, button = 'left') {
  if (!nativeReady) { console.warn('[Native] Not available'); return false; }
  try {
    if (process.platform === 'win32') {
      win_SetCursorPos(Math.round(x), Math.round(y));
      if (button === 'right') {
        win_mouse_event(MOUSEEVENTF_RIGHTDOWN, 0, 0, 0, 0);
        win_mouse_event(MOUSEEVENTF_RIGHTUP, 0, 0, 0, 0);
      } else {
        win_mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
        win_mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
      }
    } else if (process.platform === 'darwin') {
      const point = { x: x, y: y };
      const btn = button === 'right' ? kCGMouseButtonRight : kCGMouseButtonLeft;
      const downType = button === 'right' ? kCGEventRightMouseDown : kCGEventLeftMouseDown;
      const upType = button === 'right' ? kCGEventRightMouseUp : kCGEventLeftMouseUp;
      const downEvt = mac_CGEventCreateMouseEvent(null, downType, point, btn);
      mac_CGEventPost(kCGHIDEventTap, downEvt);
      mac_CFRelease(downEvt);
      const upEvt = mac_CGEventCreateMouseEvent(null, upType, point, btn);
      mac_CGEventPost(kCGHIDEventTap, upEvt);
      mac_CFRelease(upEvt);
    }
    return true;
  } catch (err) {
    console.error('[Native] Click simulation failed:', err.message);
    return false;
  }
}

// ── Virtual Key Code Maps ───────────────────────────────────
// Windows VK codes
const WIN_VK = {
  'KeyA':0x41,'KeyB':0x42,'KeyC':0x43,'KeyD':0x44,'KeyE':0x45,'KeyF':0x46,'KeyG':0x47,'KeyH':0x48,
  'KeyI':0x49,'KeyJ':0x4A,'KeyK':0x4B,'KeyL':0x4C,'KeyM':0x4D,'KeyN':0x4E,'KeyO':0x4F,'KeyP':0x50,
  'KeyQ':0x51,'KeyR':0x52,'KeyS':0x53,'KeyT':0x54,'KeyU':0x55,'KeyV':0x56,'KeyW':0x57,'KeyX':0x58,
  'KeyY':0x59,'KeyZ':0x5A,
  'Digit0':0x30,'Digit1':0x31,'Digit2':0x32,'Digit3':0x33,'Digit4':0x34,
  'Digit5':0x35,'Digit6':0x36,'Digit7':0x37,'Digit8':0x38,'Digit9':0x39,
  'F1':0x70,'F2':0x71,'F3':0x72,'F4':0x73,'F5':0x74,'F6':0x75,
  'F7':0x76,'F8':0x77,'F9':0x78,'F10':0x79,'F11':0x7A,'F12':0x7B,
  'ShiftLeft':0x10,'ShiftRight':0x10,'ControlLeft':0x11,'ControlRight':0x11,
  'AltLeft':0x12,'AltRight':0x12,'MetaLeft':0x5B,'MetaRight':0x5C,
  'ArrowUp':0x26,'ArrowDown':0x28,'ArrowLeft':0x25,'ArrowRight':0x27,
  'Home':0x24,'End':0x23,'PageUp':0x21,'PageDown':0x22,
  'Backspace':0x08,'Delete':0x2E,'Insert':0x2D,'Enter':0x0D,'NumpadEnter':0x0D,
  'Tab':0x09,'Escape':0x1B,'Space':0x20,
  'Minus':0xBD,'Equal':0xBB,'BracketLeft':0xDB,'BracketRight':0xDD,
  'Backslash':0xDC,'Semicolon':0xBA,'Quote':0xDE,'Backquote':0xC0,
  'Comma':0xBC,'Period':0xBE,'Slash':0xBF,
  'CapsLock':0x14,'NumLock':0x90,'ScrollLock':0x91,'PrintScreen':0x2C,'Pause':0x13,
  'Numpad0':0x60,'Numpad1':0x61,'Numpad2':0x62,'Numpad3':0x63,'Numpad4':0x64,
  'Numpad5':0x65,'Numpad6':0x66,'Numpad7':0x67,'Numpad8':0x68,'Numpad9':0x69,
  'NumpadMultiply':0x6A,'NumpadAdd':0x6B,'NumpadSubtract':0x6D,'NumpadDecimal':0x6E,'NumpadDivide':0x6F,
};
const WIN_EXTENDED = new Set([0x25,0x26,0x27,0x28,0x24,0x23,0x21,0x22,0x2D,0x2E,0x5B,0x5C]);

// macOS virtual key codes (from Events.h / HIToolbox)
const MAC_VK = {
  'KeyA':0x00,'KeyS':0x01,'KeyD':0x02,'KeyF':0x03,'KeyH':0x04,'KeyG':0x05,
  'KeyZ':0x06,'KeyX':0x07,'KeyC':0x08,'KeyV':0x09,'KeyB':0x0B,'KeyQ':0x0C,
  'KeyW':0x0D,'KeyE':0x0E,'KeyR':0x0F,'KeyY':0x10,'KeyT':0x11,
  'KeyI':0x22,'KeyP':0x23,'KeyL':0x25,'KeyJ':0x26,'KeyK':0x28,
  'KeyO':0x1F,'KeyU':0x20,'KeyN':0x2D,'KeyM':0x2E,
  'Digit1':0x12,'Digit2':0x13,'Digit3':0x14,'Digit4':0x15,'Digit5':0x17,
  'Digit6':0x16,'Digit7':0x1A,'Digit8':0x1C,'Digit9':0x19,'Digit0':0x1D,
  'F1':0x7A,'F2':0x78,'F3':0x63,'F4':0x76,'F5':0x60,'F6':0x61,
  'F7':0x62,'F8':0x64,'F9':0x65,'F10':0x6D,'F11':0x67,'F12':0x6F,
  'ShiftLeft':0x38,'ShiftRight':0x3C,'ControlLeft':0x3B,'ControlRight':0x3E,
  'AltLeft':0x3A,'AltRight':0x3D,'MetaLeft':0x37,'MetaRight':0x37,
  'ArrowUp':0x7E,'ArrowDown':0x7D,'ArrowLeft':0x7B,'ArrowRight':0x7C,
  'Home':0x73,'End':0x77,'PageUp':0x74,'PageDown':0x79,
  'Backspace':0x33,'Delete':0x75,'Enter':0x24,'NumpadEnter':0x4C,
  'Tab':0x30,'Escape':0x35,'Space':0x31,
  'Minus':0x1B,'Equal':0x18,'BracketLeft':0x21,'BracketRight':0x1E,
  'Backslash':0x2A,'Semicolon':0x29,'Quote':0x27,'Backquote':0x32,
  'Comma':0x2B,'Period':0x2F,'Slash':0x2C,
  'CapsLock':0x39,
};

// ── Keyboard Simulation ─────────────────────────────────────
function simulateKeypress(code, action) {
  if (!nativeReady) { console.warn('[Native] Not available'); return false; }
  try {
    if (process.platform === 'win32') {
      const vk = WIN_VK[code];
      if (vk === undefined) { console.warn(`[Native] Unknown key: ${code}`); return false; }
      let flags = 0;
      if (WIN_EXTENDED.has(vk)) flags |= KEYEVENTF_EXTENDEDKEY;
      if (action === 'up') flags |= KEYEVENTF_KEYUP;
      win_keybd_event(vk, 0, flags, 0);
    } else if (process.platform === 'darwin') {
      const vk = MAC_VK[code];
      if (vk === undefined) { console.warn(`[Native] Unknown key: ${code}`); return false; }
      const keyDown = action !== 'up';
      const evt = mac_CGEventCreateKeyboardEvent(null, vk, keyDown);
      mac_CGEventPost(kCGHIDEventTap, evt);
      mac_CFRelease(evt);
    }
    return true;
  } catch (err) {
    console.error('[Native] Keypress simulation failed:', err.message);
    return false;
  }
}

// ── WebSocket Relay Server ──────────────────────────────────
let hostWs = null;

function createWebSocketServer() {
  wss = new WebSocketServer({ host: '0.0.0.0', port: 8765 });
  console.log('[WS] WebSocket relay server listening on ws://localhost:8765');

  wss.on('connection', (ws, req) => {
    const clientIP = req.socket.remoteAddress;
    console.log(`[WS] Client connected from ${clientIP}`);

    const isLocal = clientIP === '127.0.0.1' || clientIP === '::1' || clientIP === '::ffff:127.0.0.1';
    if (isLocal && !hostWs) {
      hostWs = ws;
      console.log('[WS] Host client identified');
    }

    broadcastPeerCount();

    ws.on('message', (data) => {
      const message = data.toString();
      try {
        const parsed = JSON.parse(message);

        if (parsed.type === 'screenFrame') {
          wss.clients.forEach((client) => {
            if (client !== hostWs && client.readyState === WebSocket.OPEN) client.send(message);
          });
          return;
        }
        if (parsed.type === 'remoteKey' || parsed.type === 'click') {
          if (hostWs && hostWs.readyState === WebSocket.OPEN && ws !== hostWs) hostWs.send(message);
          return;
        }
        if (parsed.type === 'screenShareStatus') {
          wss.clients.forEach((client) => {
            if (client !== ws && client.readyState === WebSocket.OPEN) client.send(message);
          });
          return;
        }
      } catch (e) { /* not JSON, fall through */ }

      wss.clients.forEach((client) => {
        if (client !== ws && client.readyState === WebSocket.OPEN) client.send(message);
      });
    });

    ws.on('close', () => {
      console.log(`[WS] Client disconnected (${clientIP})`);
      if (ws === hostWs) { hostWs = null; console.log('[WS] Host client disconnected'); }
      broadcastPeerCount();
    });

    ws.on('error', (err) => console.error('[WS] Client error:', err.message));
  });

  wss.on('error', (err) => console.error('[WS] Server error:', err.message));
}

function broadcastPeerCount() {
  if (!wss) return;
  const count = wss.clients.size;
  const msg = JSON.stringify({ type: 'peerCount', count });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('peer-count', count);
}

// ── Electron Window ─────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 800,
    transparent: true, frame: false, alwaysOnTop: true,
    hasShadow: false, resizable: true, skipTaskbar: false,
    webPreferences: {
      nodeIntegration: false, contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  mainWindow.loadFile('index.html');
  mainWindow.setIgnoreMouseEvents(false);
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── IPC Handlers ────────────────────────────────────────────
ipcMain.handle('toggle-click-through', () => {
  if (!mainWindow) return isClickThrough;
  isClickThrough = !isClickThrough;
  if (isClickThrough) {
    mainWindow.setIgnoreMouseEvents(true, { forward: true });
  } else {
    mainWindow.setIgnoreMouseEvents(false);
  }
  console.log(`[IPC] Click-through: ${isClickThrough ? 'ON' : 'OFF'}`);
  return isClickThrough;
});

ipcMain.handle('get-click-through', () => isClickThrough);
ipcMain.handle('get-server-port', () => 8765);

ipcMain.handle('get-local-ip', () => {
  const interfaces = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (!iface.internal && iface.family === 'IPv4') {
        candidates.push({ name: name.toLowerCase(), address: iface.address });
      }
    }
  }
  if (candidates.length === 0) return '127.0.0.1';
  const preferredKeywords = ['wi-fi', 'wifi', 'wlan', 'ethernet', 'eth', 'en0', 'en1'];
  const virtualKeywords = ['zerotier', 'vmware', 'virtualbox', 'hyper-v', 'vethernet', 'docker', 'vbox', 'vpn', 'tunnel', 'utun'];
  const preferred = candidates.find(c => preferredKeywords.some(k => c.name.includes(k)));
  if (preferred) return preferred.address;
  const nonVirtual = candidates.find(c => !virtualKeywords.some(k => c.name.includes(k)));
  if (nonVirtual) return nonVirtual.address;
  return candidates[0].address;
});

ipcMain.handle('minimize-window', () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.handle('close-window', () => { if (mainWindow) mainWindow.close(); });

ipcMain.handle('set-ignore-mouse', (_event, ignore, options) => {
  if (!mainWindow) return;
  mainWindow.setIgnoreMouseEvents(ignore ? true : false, ignore ? (options || {}) : undefined);
});

// ── Remote Click Simulation ─────────────────────────────────
ipcMain.handle('simulate-click', (_event, x, y, button) => {
  if (!remoteClickEnabled) return false;
  if (mainWindow && !mainWindow.isDestroyed()) {
    const bounds = mainWindow.getBounds();
    const display = screen.getDisplayMatching(bounds);
    const scaleFactor = display ? display.scaleFactor : 1;
    const screenX = Math.round((x + bounds.x) * scaleFactor);
    const screenY = Math.round((y + bounds.y) * scaleFactor);
    console.log(`[IPC] Simulating ${button || 'left'} click at (${screenX}, ${screenY})`);
    return simulateMouseClick(screenX, screenY, button || 'left');
  }
  return false;
});

ipcMain.handle('toggle-remote-click', () => {
  remoteClickEnabled = !remoteClickEnabled;
  console.log(`[IPC] Remote Click: ${remoteClickEnabled ? 'ON' : 'OFF'}`);
  return remoteClickEnabled;
});
ipcMain.handle('get-remote-click', () => remoteClickEnabled);

// ── Screen Capture ──────────────────────────────────────────
ipcMain.handle('get-desktop-sources', async () => {
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
    return sources.map(s => ({ id: s.id, name: s.name }));
  } catch (err) {
    console.error('[IPC] Failed to get desktop sources:', err.message);
    return [];
  }
});

ipcMain.handle('toggle-screen-share', () => {
  screenShareEnabled = !screenShareEnabled;
  console.log(`[IPC] Screen Share: ${screenShareEnabled ? 'ON' : 'OFF'}`);
  return screenShareEnabled;
});
ipcMain.handle('get-screen-share', () => screenShareEnabled);

// ── Remote Keyboard Simulation ──────────────────────────────
ipcMain.handle('simulate-keypress', (_event, code, action) => {
  if (!remoteClickEnabled) return false;
  return simulateKeypress(code, action);
});

// ── Screen click with normalized coordinates ────────────────
ipcMain.handle('simulate-screen-click', (_event, screenXNorm, screenYNorm, button) => {
  if (!remoteClickEnabled) return false;
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.size;
  const sf = primaryDisplay.scaleFactor || 1;
  // On macOS, CoreGraphics uses "point" coordinates (already scaled), not raw pixels
  const useScale = process.platform === 'win32' ? sf : 1;
  const screenX = Math.round(screenXNorm * width * useScale);
  const screenY = Math.round(screenYNorm * height * useScale);
  console.log(`[IPC] Screen click at (${screenX}, ${screenY}) from norm (${screenXNorm.toFixed(3)}, ${screenYNorm.toFixed(3)})`);
  return simulateMouseClick(screenX, screenY, button || 'left');
});

// ── App Lifecycle ───────────────────────────────────────────
app.whenReady().then(() => {
  createWebSocketServer();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (wss) { wss.close(); console.log('[WS] Server closed.'); }
  if (process.platform !== 'darwin') app.quit();
});

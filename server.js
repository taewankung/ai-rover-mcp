#!/usr/bin/env node
/*
 * AI Rover Studio — MCP server.
 *
 * Speaks MCP over stdio to the AI client, and relays tool calls over a local
 * WebSocket (127.0.0.1:8765) to the simulator page (src/engine/bridge.js).
 * The rover only moves while the simulator page is open in a browser.
 *
 * Env: ROVER_BRIDGE_PORT (default 8765)
 *      ROVER_SIMULATOR_URL (optional): the page open_simulator opens, as a URL (e.g. http://localhost:5173
 *      while `npm run dev` runs) or a path to a local build (e.g. dist/index.html, relative to the working
 *      directory). Default: the hosted simulator.
 *      ROVER_ALLOWED_ORIGINS (optional): extra comma-separated https origins the bridge accepts.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WebSocketServer } from 'ws';
import { z } from 'zod';

const PORT = Number(process.env.ROVER_BRIDGE_PORT) || 8765;
const HOSTED_URL = 'https://ai-rover.app/app/';
const CALL_TIMEOUT_MS = 10_000;

// ROVER_SIMULATOR_URL as a URL; a file path becomes a file:// URL (null when the file is missing).
function simulatorBase() {
  const value = process.env.ROVER_SIMULATOR_URL;
  if (!value) return HOSTED_URL;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) return value;
  const file = path.resolve(value);
  return existsSync(file) ? pathToFileURL(file).href : null;
}

// Where open_simulator points the browser, or null when there is nothing to open yet.
function simulatorUrl() {
  const base = simulatorBase();
  if (!base) return null;
  const url = new URL(base);
  url.searchParams.set('mcp', 'on'); // a hosted page connects to a local MCP server only when asked
  if (PORT !== 8765) url.searchParams.set('mcpPort', PORT);
  return url.href;
}

const NOT_BUILT = () => `ROVER_SIMULATOR_URL points to ${path.resolve(process.env.ROVER_SIMULATOR_URL)}, which does not exist. ` +
  'Run "npm run build" in the ai-rover-studio project, or unset ROVER_SIMULATOR_URL to use the hosted simulator.';

// https origins of the hosted simulator, ROVER_SIMULATOR_URL and ROVER_ALLOWED_ORIGINS.
const SITE_ORIGINS = new Set(
  [HOSTED_URL, process.env.ROVER_SIMULATOR_URL, ...(process.env.ROVER_ALLOWED_ORIGINS ?? '').split(',')]
    .map(value => {
      try {
        const { protocol, origin } = new URL(String(value).trim());
        return protocol === 'https:' ? origin : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean),
);

// stdout carries the MCP protocol, so diagnostics go to stderr.
const debug = (...args) => console.error('[ai-rover-mcp]', ...args);

/* ---------- WebSocket bridge to the browser page ---------- */

let page = null;          // the connected simulator page (one at a time)
let pageInfo = null;      // its hello message
let bridgeError = null;   // e.g. port already in use
let nextId = 1;
const pending = new Map(); // id → { resolve, reject, timer }

// Only accept the simulator opened from disk (Origin "null"), from localhost or from the hosted
// site, so an arbitrary website in the same browser cannot pose as the rover.
function allowedOrigin(origin) {
  if (!origin || origin === 'null' || origin.startsWith('file://')) return true;
  if (SITE_ORIGINS.has(origin)) return true;
  try {
    const { hostname } = new URL(origin);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

const wss = new WebSocketServer({
  host: '127.0.0.1',
  port: PORT,
  verifyClient: ({ origin }) => allowedOrigin(origin),
});

wss.on('listening', () => debug(`bridge listening on ws://127.0.0.1:${PORT}`));
wss.on('error', err => {
  bridgeError = err.code === 'EADDRINUSE'
    ? `Port ${PORT} is already in use (another ai-rover MCP server may be running). Set ROVER_BRIDGE_PORT and open the simulator with ?mcpPort=<port>.`
    : err.message;
  debug('bridge error:', bridgeError);
});

wss.on('connection', socket => {
  if (page) page.close(4000, 'Replaced by a newer simulator tab');
  page = socket;
  pageInfo = null;
  debug('simulator page connected');

  socket.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'hello') { pageInfo = msg; return; }
    const call = pending.get(msg.id);
    if (!call) return;
    pending.delete(msg.id);
    clearTimeout(call.timer);
    if (msg.ok) call.resolve(msg.result);
    else call.reject(new Error(msg.error || 'Simulator error'));
  });

  socket.on('close', () => {
    if (page !== socket) return;
    page = null;
    pageInfo = null;
    debug('simulator page disconnected');
    for (const [id, call] of pending) {
      clearTimeout(call.timer);
      call.reject(new Error('Simulator page disconnected'));
      pending.delete(id);
    }
  });
});

function notConnectedMessage() {
  if (bridgeError) return `Rover bridge is unavailable: ${bridgeError}`;
  const url = simulatorUrl();
  if (!url) return NOT_BUILT();
  return 'The rover simulator is not connected. Call the open_simulator tool, or open ' +
    `${url} in a browser and keep the tab visible (badge "MCP ● connected").`;
}

function callPage(method, params = {}, timeoutMs = CALL_TIMEOUT_MS) {
  if (!page || page.readyState !== page.OPEN) return Promise.reject(new Error(notConnectedMessage()));
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Simulator did not answer "${method}" within ${Math.round(timeoutMs / 1000)}s. Is the browser tab visible?`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    page.send(JSON.stringify({ id, method, params }));
  });
}

/* ---------- MCP tools ---------- */

const server = new McpServer(
  { name: 'ai-rover-studio', version: '1.0.0' },
  {
    instructions: [
      'Controls the AI Rover Studio 2D simulator running in the user\'s browser (simulation only, no real hardware).',
      'World: 800×520 px canvas, walls inset 22 px, circular obstacles, one movable light source. x grows right, y grows down.',
      'Heading 0° points right (+x), 90° points down. Sensor positions are robot-local px: x forward (±22), y sideways (±23); sensor angle 0° = straight ahead.',
      'Sensors: sonar / ir (distance, cm), light (0–100 %), bumper (true on collision), button (true while a person holds it; get_button_events / press_button), color (the floor-tape color under it, else "yellow" near the light, else "dark").',
      'Head module: set_head turns the face (pan servo, −90…90° from the heading) or tracks the light with the head light sensors; light sensors are directional.',
      'Camera module: capture_camera returns a first-person image plus detections (bearing_deg, distance_cm); get_observation also lists camera detections.',
      'Sensor map: get_sensor_map returns what the rover has mapped from its own sensors (occupancy grid, floor colors, camera landmarks, bumps).',
      'World: obstacles can be circles (cylinder, ball) or rotated boxes (box, wall); edit them with add_obstacle / remove_obstacle and colored floor tape with add_color_tape; list_world shows the layout.',
      'Typical loop: get_observation → decide → drive (short moves, 0.2–10 s, waits by default) → read_sensors → repeat.',
      'If a tool says the simulator is not connected, call open_simulator first.',
    ].join('\n'),
  },
);

const text = value => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });

// Registers a tool that forwards its arguments to the page method of the same name.
function pageTool(name, config, { timeout } = {}) {
  server.registerTool(name, config, async (args = {}) => {
    try {
      return text(await callPage(name, args, timeout ? timeout(args) : undefined));
    } catch (err) {
      return { ...text(err.message), isError: true };
    }
  });
}

const readOnly = { readOnlyHint: true, openWorldHint: false };
const sensorType = z.enum(['sonar', 'light', 'bumper', 'ir', 'color', 'button']);
const sensorFields = {
  name: z.string().max(40).optional().describe('Display name'),
  x: z.number().min(-22).max(22).optional().describe('Local x in px (forward +, rear −)'),
  y: z.number().min(-23).max(23).optional().describe('Local y in px (right side +, left side −)'),
  angle: z.number().optional().describe('Facing angle in degrees, 0 = forward, 90 = right side (wrapped to −180…180)'),
  range: z.number().min(5).max(300).optional().describe('Detection range in cm'),
  enabled: z.boolean().optional(),
};

server.registerTool('open_simulator', {
  title: 'Open simulator',
  description: 'Open the AI Rover Studio page in the default browser and wait (up to 15 s) for it to connect to this MCP server.',
  annotations: { readOnlyHint: false, openWorldHint: false },
}, async () => {
  if (bridgeError) return { ...text(notConnectedMessage()), isError: true };
  // An already-open tab retries every ≤3 s; give it a chance before opening another one.
  for (let waited = 0; waited < 3500 && !page; waited += 250) await new Promise(r => setTimeout(r, 250));
  if (page) return text({ connected: true, page: pageInfo, note: 'Simulator already connected.' });

  const url = simulatorUrl();
  if (!url) return { ...text(NOT_BUILT()), isError: true };
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]]
      : ['xdg-open', [url]];
  spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();

  for (let waited = 0; waited < 15_000 && !page; waited += 250) await new Promise(r => setTimeout(r, 250));
  return page
    ? text({ connected: true, url, page: pageInfo })
    : { ...text(`Opened ${url} but the page has not connected yet. Check the browser tab and its "MCP" badge.`), isError: true };
});

server.registerTool('connection_status', {
  title: 'Connection status',
  description: 'Report whether the simulator page is connected to this MCP server.',
  annotations: readOnly,
}, async () => text({
  connected: !!page,
  bridge: `ws://127.0.0.1:${PORT}`,
  bridge_error: bridgeError,
  page: pageInfo,
  simulator_url: simulatorUrl(),
}));

pageTool('get_observation', {
  title: 'Get observation',
  description: 'Current robot pose (x, y, heading_deg), velocity, every enabled sensor reading, face display state, plus simulation status (running, autopilot, power, lamp position).',
  annotations: readOnly,
});

pageTool('read_sensors', {
  title: 'Read sensors',
  description: 'Fresh readings from all enabled sensors, with their mounting position, angle, range and unit.',
  annotations: readOnly,
});

pageTool('drive', {
  title: 'Drive',
  description: 'Move the rover for a fixed time: forward / backward, or turn left / right in place. Turns autopilot off and starts the simulation. ' +
    'Rotation speed is about 2 rad/s (≈115°/s), so turning 90° takes ≈0.8 s. Forward speed is 65 % of max speed (≈61 px/s at the default 55 % power; backward ≈51 px/s). ' +
    'With wait=true (default) it returns the observation after the move finishes. The rover stops on collisions.',
  inputSchema: {
    direction: z.enum(['forward', 'backward', 'left', 'right']),
    seconds: z.number().min(0.2).max(10).optional().describe('Duration, 0.2–10 s (default 2 for forward/backward, 1 for turns)'),
    wait: z.boolean().optional().describe('Wait for the move to finish before returning (default true)'),
  },
  annotations: { readOnlyHint: false, openWorldHint: false },
}, { timeout: ({ seconds = 2 }) => seconds * 1000 + 8000 });

pageTool('turn', {
  title: 'Turn by degrees',
  description: 'Turn the rover in place by an exact angle (+ = right / clockwise, − = left) at ≈115°/s, then return the observation. ' +
    'Unlike drive left/right there is no 0.2 s minimum, so small corrections (e.g. 7°) are exact.',
  inputSchema: { degrees: z.number().min(-360).max(360) },
  annotations: { readOnlyHint: false, openWorldHint: false },
}, { timeout: ({ degrees }) => Math.abs(degrees) / 115 * 1000 + 8000 });

pageTool('run_program', {
  title: 'Run a rover program',
  description: 'Run JavaScript on the robot with the `rover` library (same as the Code page; it replaces any running program and starts the simulation). ' +
    'Top-level await works. Motion (await): rover.forward(s), backward(s), turn(deg), left(s), right(s); rover.drive(speed −1…1, turn °/s) keeps going; rover.stop(); rover.power(%). ' +
    'Readings (sync, 50 ms snapshots): rover.read(id), sensors(), distance() (nearest sonar/IR cm), light() (%), bumped(), pose(), time(). ' +
    'Head/face: await rover.head(deg), trackLight(on), headAngle(); rover.face(emotion, text), say(text, s). ' +
    'Buttons: pressed(id), onButton([id], fn(event)), await waitButton([id]). Time/output: await wait(s), await rover.until(fn, timeout), log(...). ' +
    'Customise: await rover.module(name, on), addSensor({type,name,x,y,angle,range}), updateSensor(id, fields), removeSensor(id), sensorList(). ' +
    'Returns immediately; poll get_program for status and the console.',
  inputSchema: { code: z.string().min(1).max(20000) },
  annotations: { readOnlyHint: false, openWorldHint: false },
});

pageTool('stop_program', {
  title: 'Stop the program',
  description: 'Stop the running rover program (its worker is terminated, the wheels stop).',
  annotations: { readOnlyHint: false, idempotentHint: true },
});

pageTool('get_program', {
  title: 'Program status',
  description: 'The current/last rover program: code, status (idle, running, listening, done, stopped, error), error { message, line } and the last 50 console lines.',
  annotations: readOnly,
});

pageTool('stop', {
  title: 'Stop',
  description: 'Emergency stop: cancel any movement, turn autopilot off and pause the simulation.',
  annotations: { readOnlyHint: false, idempotentHint: true },
});

pageTool('set_simulation', {
  title: 'Start / pause simulation',
  description: 'Start (running=true) or pause (running=false) the physics simulation.',
  inputSchema: { running: z.boolean() },
  annotations: { idempotentHint: true },
});

pageTool('set_autopilot', {
  title: 'Autopilot',
  description: 'Enable the built-in rule-based autopilot (seeks the light, backs away from obstacles; also starts the simulation) or disable it.',
  inputSchema: { enabled: z.boolean() },
  annotations: { idempotentHint: true },
});

pageTool('set_power', {
  title: 'Motor power',
  description: 'Set motor power in percent (10–100). Max speed is 170 px/s at 100 % (drive uses 65 % of it forward, 55 % backward).',
  inputSchema: { percent: z.number().min(10).max(100) },
  annotations: { idempotentHint: true },
});

pageTool('set_emotion', {
  title: 'Face expression',
  description: 'Show an expression on the robot\'s face display (emulated SSD1306 128×64 OLED); the message appears in the top text line and scrolls if long. ' +
    'Held ~5 s before sensor-driven emotions resume.',
  inputSchema: {
    emotion: z.enum(['happy', 'curious', 'thinking', 'surprised', 'sad', 'neutral']),
    message: z.string().max(120).optional().describe('Speech text shown under the face'),
  },
});

pageTool('display_text', {
  title: 'Show text on the display',
  description: 'Make the rover "say" a text on the Face Display module (128×64 OLED): a small rover face with a talking mouth ' +
    'and the text typed out in a speech bubble (Thai supported, ~11 characters per line, 2 lines per bubble, extra bubbles follow). ' +
    'Returns to the big face after `seconds`, or once every bubble has been shown if that takes longer.',
  inputSchema: {
    text: z.string().min(1).max(200),
    seconds: z.number().min(1).max(60).optional().describe('How long to show it (default 6)'),
  },
});

const displayModel = z.enum(['ssd1306', 'ssd1331', 'st7789']);
const panelColor = z.enum(['yellow-blue', 'white', 'blue', 'yellow'])
  .describe('SSD1306 panel colour: yellow-blue (top 16 rows yellow, rest blue; the default), white, blue or yellow');

pageTool('set_display', {
  title: 'Choose the display module',
  description: 'Fit a different Face Display module: "ssd1306" (0.96" 128×64 monochrome OLED, I²C; default), ' +
    '"ssd1331" (0.95" 96×64 colour RGB OLED, SPI) or "st7789" (1.3" 240×240 colour IPS TFT, SPI). ' +
    'Faces and text adapt to the resolution; colour modules show a colour per emotion. `panel` changes the SSD1306 glass colour. ' +
    'Returns read_display.',
  inputSchema: { model: displayModel.optional(), panel: panelColor.optional() },
  annotations: { idempotentHint: true },
});

pageTool('draw_display', {
  title: 'Draw a picture on the display',
  description: 'Show a picture on the Face Display module for `seconds`, then return to the face. ' +
    'Pass one string per pixel row, at most the module\'s resolution (SSD1306 128×64, SSD1331 96×64, ST7789 240×240; see read_display). ' +
    'Characters space . 0 - _ are dark. On colour modules (SSD1331, ST7789) these letters pick a colour: R red, O orange, Y yellow, ' +
    'G green, C cyan, B blue, P purple, M pink, W white, A grey, N brown, K black; any other character is white, and `palette` adds or ' +
    'overrides letters. On the monochrome SSD1306 every non-blank, non-black character is a lit pixel and colour comes from its panel ' +
    'variant (`panel`). The picture is centred; `scale` enlarges each pixel (e.g. 64×32 with scale 2 fills 128×64) and is lowered if it ' +
    'would not fit. Returns read_display, so the result shows what the module actually displays.',
  inputSchema: {
    rows: z.array(z.string().max(240)).min(1).max(240).describe('Pixel rows, top to bottom'),
    palette: z.record(z.string().length(1), z.string().regex(/^#[0-9a-fA-F]{6}$/)).optional()
      .describe('Extra colour letters, e.g. {"s": "#87ceeb"} (colour modules)'),
    panel: panelColor.optional(),
    scale: z.number().int().min(1).max(16).optional().describe('Pixel size (default 1)'),
    seconds: z.number().min(1).max(300).optional().describe('How long to show it (default 10)'),
  },
});

pageTool('read_display', {
  title: 'Read the display',
  description: 'Read back what the Face Display module is showing: mode (face/text), text lines, module stats (frames, fps, bytes) ' +
    'and the actual 128×64 pixels from the module\'s GDDRAM as ASCII art (█▀▄, 2 pixel rows per line).',
  annotations: readOnly,
});

pageTool('move_light', {
  title: 'Move light source',
  description: 'Move the light source to world coordinates (clamped to 42–758 × 42–478).',
  inputSchema: { x: z.number(), y: z.number() },
  annotations: { idempotentHint: true },
});

pageTool('reset_world', {
  title: 'Reset world',
  description: 'Put the rover back at its start pose (120, 265, heading 0°) and the light at (690, 70). Turns autopilot off.',
  annotations: { idempotentHint: true },
});

pageTool('send_chat', {
  title: 'Send chat command',
  description: 'Send a message to the in-page Agent Chat (offline Thai/English command parser, e.g. "ไปหาแสง", "อ่านเซนเซอร์", "เดินหน้า 2 วินาที") and return the rover\'s reply. It shows up in the chat panel.',
  inputSchema: { text: z.string().min(1).max(300) },
});

pageTool('get_manifest', {
  title: 'Get robot manifest',
  description: 'The Robot Capability Manifest (ai-cartridge/body-v1): motors, installed sensor modules and display.',
  annotations: readOnly,
});

pageTool('list_sensors', {
  title: 'List sensors',
  description: 'All configured sensors (enabled or not) with id, type, mounting position, angle and range.',
  annotations: readOnly,
});

pageTool('add_sensor', {
  title: 'Add sensor',
  description: 'Install a new sensor on the rover body. Unspecified fields use the type defaults (centre of the body, facing forward).',
  inputSchema: { type: sensorType, ...sensorFields },
});

pageTool('update_sensor', {
  title: 'Update sensor',
  description: 'Change a sensor\'s name, type, mounting position, angle, range or enabled flag. Use list_sensors to find ids.',
  inputSchema: { id: z.string(), type: sensorType.optional(), ...sensorFields },
});

pageTool('remove_sensor', {
  title: 'Remove sensor',
  description: 'Uninstall a sensor by id.',
  inputSchema: { id: z.string() },
  annotations: { destructiveHint: true },
});

pageTool('set_module', {
  title: 'Install / remove a module',
  description: 'Install or remove a body module: "wheels" (drive motors + wheels; without them the rover cannot move), ' +
    '"head" (pan servo that turns the face and the light sensors), "display" (AI Face Display OLED) or "camera" (forward-facing camera).',
  inputSchema: { module: z.enum(['wheels', 'head', 'display', 'camera']), installed: z.boolean() },
  annotations: { idempotentHint: true },
});

pageTool('set_head', {
  title: 'Turn the head',
  description: 'Control the Head module (pan servo, needs set_module head first). angle_deg turns the face to −90…90° relative to the body ' +
    '(+ = right, servo ≈180°/s) and switches to manual. track_light=true makes the head find and follow the light with its own light ' +
    'sensors: it sweeps the full range, settles on the brightest angle and keeps hill-climbing (rescans if the light is lost). ' +
    'Light sensors are directional (brightest when facing the lamp) and ride on the head. Starts the simulation.',
  inputSchema: {
    angle_deg: z.number().min(-90).max(90).optional(),
    track_light: z.boolean().optional(),
  },
  annotations: { readOnlyHint: false, openWorldHint: false },
});

pageTool('press_button', {
  title: 'Press a button',
  description: 'Press a push-button module (a sensor of type "button") for `seconds` and release it, like a person would. ' +
    'Held ≥ 0.8 s is a long press. The built-in program reacts: short press toggles the head\'s light tracking (happy face), ' +
    'long press stops everything (driving, autopilot, tracking; pauses the simulation). Returns the press event.',
  inputSchema: {
    id: z.string().describe('Button sensor id (list_sensors)'),
    seconds: z.number().min(0.05).max(5).optional().describe('How long to hold it (default 0.2 s)'),
  },
  annotations: { readOnlyHint: false, openWorldHint: false },
}, { timeout: ({ seconds = 0.2 }) => seconds * 1000 + 5000 });

pageTool('get_button_events', {
  title: 'Button events',
  description: 'Button presses since the last call (oldest first, then cleared): { id, name, press: "short" | "long", seconds, at (ms epoch) }, ' +
    'plus every button and whether it is held right now. People press buttons in the simulator page; poll this to react to them.',
  annotations: { readOnlyHint: false, openWorldHint: false },
});

pageTool('get_head', {
  title: 'Head status',
  description: 'Head module status: angle_deg, target_deg, mode (manual / track_light), tracking phase and the head light brightness.',
  annotations: readOnly,
});

server.registerTool('capture_camera', {
  title: 'Capture camera image',
  description: 'Take a picture with the rover\'s forward-facing camera (needs the camera module). Returns a 320×240 first-person PNG ' +
    '(walls, colored obstacles, colored floor tape, the light source) and a JSON list of what is in view: ' +
    'type (obstacle / tape / light), id, color, bearing_deg (0 = straight ahead, + = right) and distance_cm.',
  inputSchema: {
    fov_deg: z.number().min(40).max(100).optional().describe('Change the horizontal field of view first (default 60°)'),
  },
  annotations: readOnly,
}, async (args = {}) => {
  try {
    const { image_base64: data, mime_type: mimeType, ...info } = await callPage('capture_camera', args);
    return { content: [{ type: 'image', data, mimeType }, { type: 'text', text: JSON.stringify(info, null, 2) }] };
  } catch (err) {
    return { ...text(err.message), isError: true };
  }
});

pageTool('get_sensor_map', {
  title: 'Get sensor map',
  description: 'The map the rover has built from its own sensors only (not the true layout): an occupancy grid of 10 px cells ' +
    'as ASCII rows ("#" occupied by a sonar/IR echo or bumper hit, "." free, " " unknown, "@" rover, a capital letter = floor color ' +
    'read by a color sensor), camera landmarks with estimated world x/y, bumper hit points, the pose and exploration stats. ' +
    'clear=true wipes the map first.',
  inputSchema: { clear: z.boolean().optional().describe('Clear the map before returning it (default false)') },
  annotations: { readOnlyHint: false, openWorldHint: false },
});

pageTool('get_wiring', {
  title: 'Get wiring',
  description: 'How the fitted rover body wires to a real microcontroller (the Wiring page): for each part (TB6612FNG motor driver, ' +
    'each enabled sensor, the display module, the camera) every pin and where it goes (MCU pin or 5V / 3V3 / GND / VBAT rail), ' +
    'the power budget per rail, issues found (pin conflicts, missing pins, 5 V signals into 3.3 V pins, duplicate I²C addresses, ' +
    'ESP32 strapping / ADC2 pins) and a ready-to-use pin file (Arduino pins.h, or pins.py with BCM numbers on the Pi). ' +
    '`board` switches the board first: "esp32" (ESP32 DevKit V1), "uno" (Arduino Uno R3) or "raspberrypi" (Raspberry Pi 4/5 40-pin header; ' +
    'analog sensors go through an ADS1115 on I²C, the camera on the CSI ribbon).',
  inputSchema: { board: z.enum(['esp32', 'uno', 'raspberrypi']).optional() },
  annotations: { readOnlyHint: false, openWorldHint: false },
});

pageTool('get_bom', {
  title: 'Get parts list',
  description: 'Bill of materials for building the fitted rover body for real (the parts tab on the Wiring page): ' +
    'the board, motor driver, every enabled sensor, display, camera and head servo, plus the parts the circuit needs ' +
    'around them (chassis, battery, buck converter, voltage-divider resistors, level shifter …), each with quantity, ' +
    'approximate price in THB and shop links when known, and a plain-text list to copy. ' +
    '`board` switches the board first: "esp32", "uno" or "raspberrypi".',
  inputSchema: { board: z.enum(['esp32', 'uno', 'raspberrypi']).optional() },
  annotations: { readOnlyHint: false, openWorldHint: false },
});

pageTool('get_firmware', {
  title: 'Get firmware',
  description: 'A complete program for the real robot, generated from the fitted body and the wiring pin map: an Arduino sketch ' +
    '(rover_firmware.ino) for "esp32" / "uno", or a Python script (rover.py) for "raspberrypi". It drives the TB6612FNG wheels, ' +
    'reads every enabled sensor, turns the head servo (with light tracking), draws faces on the display and runs the same ' +
    'auto emotions / rule-based autopilot as the simulator. Text commands over Serial 115200 / stdin: READ, F|B|L|R <s>, AUTO 0|1, ' +
    'POWER <%>, HEAD <deg>, TRACK 0|1, EMO <emotion> [text], SAY <text>, STOP. Returns { name, text }. `board` switches the board first.',
  inputSchema: { board: z.enum(['esp32', 'uno', 'raspberrypi']).optional() },
  annotations: { readOnlyHint: false, openWorldHint: false },
});

const paletteColor = z.enum(['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'white', 'black', 'gray']);

pageTool('list_world', {
  title: 'List world layout',
  description: 'World size, light position, all obstacles (id, kind, shape, position, size, color) and colored floor tapes.',
  annotations: readOnly,
});

pageTool('add_obstacle', {
  title: 'Add obstacle',
  description: 'Place an object in the world to test sensors, collisions or the camera. Kinds: cylinder / ball (circle, radius r), ' +
    'box / wall (rectangle w × h, rotated by angle°). Unspecified size and color use the kind\'s defaults. ' +
    'Refused if it would overlap the rover.',
  inputSchema: {
    kind: z.enum(['cylinder', 'box', 'wall', 'ball']),
    x: z.number().describe('World x (px)'),
    y: z.number().describe('World y (px)'),
    r: z.number().min(8).max(90).optional().describe('Radius for cylinder / ball'),
    w: z.number().min(8).max(320).optional().describe('Width for box / wall'),
    h: z.number().min(8).max(320).optional().describe('Height (depth) for box / wall'),
    angle: z.number().optional().describe('Rotation in degrees for box / wall'),
    color: paletteColor.optional(),
  },
});

pageTool('remove_obstacle', {
  title: 'Remove obstacle',
  description: 'Remove an obstacle by id (see list_world).',
  inputSchema: { id: z.string() },
  annotations: { destructiveHint: true },
});

pageTool('add_color_tape', {
  title: 'Add colored floor tape',
  description: 'Stick a strip of colored tape on the floor (for the color sensor, line following and the camera). ' +
    'A color sensor over the tape reads its color name.',
  inputSchema: {
    color: paletteColor,
    x: z.number().describe('Centre x (px)'),
    y: z.number().describe('Centre y (px)'),
    length: z.number().min(10).max(400).optional().describe('Length in px (default 100)'),
    width: z.number().min(6).max(120).optional().describe('Width in px (default 18)'),
    angle: z.number().optional().describe('Rotation in degrees (0 = along x)'),
  },
});

pageTool('remove_color_tape', {
  title: 'Remove colored floor tape',
  description: 'Remove a floor tape by id (see list_world).',
  inputSchema: { id: z.string() },
  annotations: { destructiveHint: true },
});

/* ---------- Start ---------- */

await server.connect(new StdioServerTransport());
debug(`MCP server ready (simulator: ${simulatorUrl() ?? 'not built'})`);

const shutdown = () => {
  wss.close();
  process.exit(0);
};
process.stdin.on('close', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

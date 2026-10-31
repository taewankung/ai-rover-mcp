# ai-rover-mcp

MCP server for [AI Rover Studio](https://ai-rover.app/), a 2D robot simulator
that runs in the browser. It lets an AI agent (Claude Code, Claude Desktop or any MCP
client) observe and drive the rover, change its body, run programs and read the real
wiring for an ESP32 / Arduino Uno / Raspberry Pi. Simulation only: nothing is sent to hardware.

```
MCP client ──stdio──▶ ai-rover-mcp ──WebSocket 127.0.0.1:8765──▶ simulator page in your browser
```

The page must be open in a browser **and the tab must stay visible**, because browsers
pause animation frames in background tabs, so the simulation stops there. The badge in
the page header shows `MCP ● connected` while the bridge is up.

## Setup

Needs Node.js 18 or newer.

### Claude Code

```bash
claude mcp add ai-rover -- npx -y ai-rover-mcp
```

Then ask Claude to *"open the rover simulator"*. `open_simulator` opens the hosted simulator
with `?mcp=on`, which tells the page to connect to this server.

### Claude Desktop / other clients

```json
{
  "mcpServers": {
    "ai-rover": {
      "command": "npx",
      "args": ["-y", "ai-rover-mcp"]
    }
  }
}
```

### From a clone

```bash
npm install
claude mcp add ai-rover -- node /path/to/ai-rover-mcp/server.js
```

## Opening the simulator yourself

Open `https://ai-rover.app/app/?mcp=on`. Without `?mcp=on` the hosted page does not
try to reach a local MCP server; you can also press **เชื่อมต่อ MCP** on its Agent / MCP page.
A copy opened from disk (`file://`) or from `localhost` connects on its own.

## Tools

| Tool | What it does |
| --- | --- |
| `open_simulator` | Opens the simulator (hosted, or `ROVER_SIMULATOR_URL`) in the default browser and waits for it to connect |
| `connection_status` | Whether the page is connected |
| `get_observation` | Pose, velocity, sensor readings, face state and simulation status |
| `read_sensors` | Fresh readings from the enabled sensors, with mounting info and units |
| `drive` | `forward` / `backward` / `left` / `right` for 0.2–10 s; waits by default and returns the new observation |
| `turn` | Turn on the spot by an exact angle |
| `stop` | Emergency stop: cancels movement, turns autopilot off, pauses |
| `set_simulation` | Start or pause the simulation |
| `set_autopilot` | Rule-based autopilot (seek light, avoid obstacles) on or off |
| `set_power` | Motor power, 10–100 % |
| `set_head` / `get_head` | Head pan servo: turn to an angle, or track the light |
| `press_button` / `get_button_events` | Press a push button on the rover / read presses made by a person |
| `run_program` / `stop_program` / `get_program` | Run JavaScript that uses the `rover` library in the page, stop it, read its status and console |
| `set_emotion` | Face expression on the display, with a message in the top line |
| `display_text` | The rover "says" a text: small face + speech bubble on the Face Display (Thai supported) |
| `set_display` | Fit a display module: `ssd1306` (128×64 mono OLED), `ssd1331` (96×64 colour OLED) or `st7789` (240×240 colour TFT) |
| `draw_display` | Show a picture on the Face Display from rows of characters |
| `read_display` | What the display shows: mode, stats and pixels as ASCII art |
| `move_light` | Move the light source |
| `reset_world` | Rover and light back to their start positions |
| `send_chat` | Send text to the in-page Agent Chat parser and get its reply |
| `get_manifest` | Robot Capability Manifest (`ai-cartridge/body-v1`) |
| `list_sensors` / `add_sensor` / `update_sensor` / `remove_sensor` | Configure the sensors on the robot body |
| `set_module` | Fit or remove `wheels`, `head`, `display` or `camera` |
| `capture_camera` | Picture from the rover's forward camera (PNG image) plus detections with bearing and distance |
| `get_sensor_map` | Map the rover built from its own sensors: occupancy grid, floor colors, camera landmarks, bump points |
| `get_wiring` | Circuit for the fitted body on `esp32`, `uno` or `raspberrypi`: every pin, power budget, wiring issues, `pins.h` / `pins.py` |
| `get_firmware` | Complete firmware for the fitted body: Arduino `.ino` or Raspberry Pi `rover.py` |
| `get_bom` | Parts list to build the fitted body for real, with quantities, approximate prices and shop links |
| `list_world` | World layout: light, obstacles, colored floor tape |
| `add_obstacle` / `remove_obstacle` | Place test objects: `cylinder`, `ball`, `box` or `wall`, with size and color |
| `add_color_tape` / `remove_color_tape` | Colored floor tape for the color sensor, line following and the camera |

Example prompts: *"Open the rover simulator and drive it to the light without using the
autopilot"*, *"Add an IR sensor on each side angled ±45° and tell me the readings"*,
*"What parts do I need to build this rover on an ESP32?"*

## Configuration

- `ROVER_BRIDGE_PORT` (default `8765`). If you change it, the page needs `?mcpPort=<port>`
  (`open_simulator` adds this for you).
- `ROVER_SIMULATOR_URL`: the page `open_simulator` opens instead of the hosted one. A URL
  (`http://localhost:5173` while developing) or a path to a local build (`dist/index.html`,
  relative to the working directory).
- `ROVER_ALLOWED_ORIGINS`: extra comma-separated `https://` origins the bridge accepts
  (for a self-hosted copy of the simulator).
- On the page: `?mcp=on` connects to the server, `?mcp=off` never does.

## Security

The WebSocket listens on `127.0.0.1` only. It accepts connections only from the page
opened from disk (`file://`), from `localhost`, from the hosted simulator, or from the
origin of `ROVER_SIMULATOR_URL` / `ROVER_ALLOWED_ORIGINS`, so other websites open in the
same browser cannot pose as the rover. The page only runs the fixed set of methods listed
above; it never evaluates code it receives from the server, except the program you send
with `run_program`, which runs in a Web Worker.

## License

MIT

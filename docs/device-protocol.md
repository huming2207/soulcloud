# Device protocol

This is the contract between a device and SoulCloud. It is written for the
ESP32 family but nothing in it is ESP32-specific except the firmware image
format used for OTA.

A device talks to the platform in two ways:

- **HTTPS**, for enrollment and firmware downloads only;
- **MQTT 5 over WebSocket** (`ws://` in development, `wss://` behind the
  reverse proxy in production), for everything else. Raw MQTT over TCP is not
  offered.

## 1. Enrollment

Every enrollment pairs a device with a user and yields a brand-new device id
and MQTT password. When the same user enrolls the same hardware (same
`hardwareId`) again, the previous id is retired: its credentials stop working
and its connection is closed. Enrolling it under a different user leaves the
old owner's record in place (offline); the old owner can unpair it.

1. The user creates a pairing token in the app (`POST /v1/enrollments`). It
   looks like `K7QD-M3XA-9PZT-4HNC`, is single-use and expires (10 minutes by
   default).
2. The provisioning app hands the token to the device, for example in the
   custom data of ESP-IDF Wi-Fi provisioning (BLE or SoftAP).
3. The device redeems it:

```http
POST /v1/device/enroll
Content-Type: application/json

{
  "token": "K7QD-M3XA-9PZT-4HNC",
  "hardwareId": "24:6f:28:aa:bb:cc",
  "platform": "esp32",
  "chip": "esp32s3",
  "fwVersion": "1.0.0",
  "name": "optional display name"
}
```

`hardwareId` must be stable for the physical unit (the base MAC address is a
good choice). `platform` is `esp32` for the whole ESP32 family; `chip` is the
IDF target name.

```http
201 Created

{
  "deviceId": "7KQ2M-XH9PA",
  "name": "bench unit",
  "mqtt": {
    "url": "wss://iot.example.com/ws",
    "username": "7KQ2M-XH9PA",
    "password": "q3V…32 chars…",
    "clientId": "7KQ2M-XH9PA",
    "protocolVersion": 5
  },
  "topics": { "prefix": "d/7KQ2M-XH9PA/", "publish": "d/7KQ2M-XH9PA/up/#", "subscribe": "d/7KQ2M-XH9PA/down/#" }
}
```

Store the id and password in NVS. The password is never shown again. Errors:
`401 invalid_token` (wrong, used or expired token), `400 unsupported_platform`,
`429 rate_limited`.

Device ids use the alphabet `23456789ABCDEFGHJKLMNPQRSTUVWXYZ` (no `0`, `1`,
`I`, `O`) in the form `XXXXX-XXXXX`.

## 2. Connecting

| Setting | Value |
|---|---|
| URL | `mqtt.url` from enrollment |
| Protocol | MQTT 5.0 |
| Client id | the device id (must equal the username, or the connection is refused) |
| Username / password | from enrollment |
| Clean start | `false`, with a Session Expiry Interval (e.g. 3600 s) so requests sent while the device is briefly offline are kept |
| Keep alive | 30–60 s |

After connecting, subscribe to `d/<id>/down/#` with QoS 1 and publish a birth
status message (section 3).

A device may only publish under `d/<id>/up/` and subscribe under
`d/<id>/down/`. Anything else is refused by the broker and closes the
connection.

With ESP-MQTT that is roughly:

```c
esp_mqtt_client_config_t cfg = {
    .broker.address.uri = url,                 // "wss://…/ws"
    .credentials.username = id,
    .credentials.client_id = id,
    .credentials.authentication.password = password,
    .session.protocol_ver = MQTT_PROTOCOL_V_5,
    .session.disable_clean_session = true,
    .session.keepalive = 60,
};
```

## 3. Topics

| Topic | Direction | Payload | QoS |
|---|---|---|---|
| `d/<id>/up/status` | device → cloud | JSON status (3.1) | 1 |
| `d/<id>/up/log/text` | device → cloud | text lines (3.2) | 0 or 1 |
| `d/<id>/up/log/bin` | device → cloud | on9log packets (3.3) | 0 or 1 |
| `d/<id>/up/evt/<name>` | device → cloud | JSON event (3.6) | 1 |
| `d/<id>/up/res` | device → cloud | response to a cloud request (3.4) | 1 |
| `d/<id>/up/req/<method>` | device → cloud | request to the cloud (3.5) | 1 |
| `d/<id>/down/req/<method>` | cloud → device | request (3.4) | 1 |
| `d/<id>/down/res` | cloud → device | response to a device request (3.5) | 1 |

Dotted method and event names map to topic levels: method `ota.start` arrives
on `d/<id>/down/req/ota/start`; the device calls `ota.check` by publishing to
`d/<id>/up/req/ota/check`.

Messages are limited to 256 KiB.

### 3.1 Status (birth and heartbeat)

Publish once right after connecting with `"birth": true`, then periodically
(e.g. every 60 s) without it. Only `uptimeMs` is required.

```json
{
  "birth": true,
  "uptimeMs": 123456,
  "bootId": 3735928559,
  "resetReason": 1,
  "fw": { "version": "1.2.0", "elfSha256": "7f3a9c…", "project": "my-app", "sdk": "v5.5" },
  "chip": "esp32s3",
  "heap": { "free": 182344, "minFree": 150112 },
  "rssi": -61,
  "extra": { "anything": "device-defined" }
}
```

- `resetReason`: `esp_reset_reason()` as a number (names such as `power_on`
  and `task_wdt` are derived by the platform), or a string.
- `fw.elfSha256`: `esp_app_get_description()->app_elf_sha256` as hex. The
  full 64 characters are preferred; a prefix of at least 8 characters is
  accepted. It tells the platform which firmware is running, which binary log
  decoding and OTA completion depend on.
- `bootId`: a random number picked once per boot (the same one on9log uses).

Online/offline state does not depend on this message: the platform learns about
connects and disconnects from the broker.

### 3.2 Text logs

UTF-8 text, one log line per `\n`. ESP-IDF formatted lines are parsed into
level, tag and time:

```
I (1234) wifi: connected
W (5678) app: low heap
```

ANSI colour codes are stripped. Other lines are stored as info-level messages.
Batch lines (up to 2000 per message) instead of sending one message per line.

### 3.3 Binary logs (on9log)

The payload is one or more raw on9log packets back to back. Do not add SLIP
framing; each packet's `payload_len` delimits it.

- **TIME_SYNC.** End each batch with a TIME_SYNC packet (`on9log_encode_time_sync`).
  The platform uses it to estimate the wall-clock time of every packet in the
  batch.
- **BOOT.** Send the BOOT packet (`on9log_emit_boot`) after startup. It updates
  the device's boot id and reset reason.
- **Decoding.** Packets are decoded with the ELF of the firmware the device
  reported in its last status. That ELF has to be uploaded with the firmware
  (`POST /v1/firmware`, or later with `PUT /v1/firmware/{id}/elf`). Until then,
  entries show the raw addresses and arguments. Once the ELF is uploaded, logs
  already stored become decodable too.

### 3.4 Cloud → device requests

The platform publishes to `d/<id>/down/req/<method>` with:

- a JSON object of parameters as the payload;
- **Response Topic** `d/<id>/up/res`;
- **Correlation Data**, an opaque id (currently a UUID string);
- the user property `expires-at` (ISO time). Drop a request that arrives after
  it.

Answer on the Response Topic and copy the Correlation Data:

```json
{ "ok": true, "result": { "code": 0, "output": "Total 182344; Min blk: 98304" } }
{ "ok": false, "error": "unknown command" }
```

Built-in methods:

| Method (topic) | Params | Result |
|---|---|---|
| `shell` | `{ "line": "get free_heap internal" }` | `{ "code": 0, "output": "…" }` |
| `reboot` | `{ "delayMs"?: 500 }` | answer before restarting |
| `info` | `{}` | free-form: app description, ELF hash, partitions, heap |
| `log.config` (`log/config`) | `{ "level"?: "info", "tags"?: { "wifi": "debug" }, "text"?: true, "bin"?: true }` | `{}` |
| `ota.start` (`ota/start`) | see section 4 | `{}` once the update is accepted |
| `ota.cancel` (`ota/cancel`) | `{ "taskId": "…" }` | `{}` |

`shell` is the remote debug console. The device defines its own verbs
(`get free_heap internal`, `status uptime`, `get app_desc`, and so on). Users
can also send any other method name with free-form params. Answer unknown
methods with `{ "ok": false, "error": "unknown method" }`.

### 3.5 Device → cloud requests

Publish to `d/<id>/up/req/<method>`, setting Response Topic
`d/<id>/down/res` and your own Correlation Data. The answer has the same
`{ok, result | error}` shape and echoes your Correlation Data.

| Method (topic) | Params | Result |
|---|---|---|
| `time` | `{}` | `{ "epochMs": 1791716450579 }` |
| `ota.check` (`ota/check`) | `{}` | `{ "update": null }` or `{ "update": <ota.start params> }` |

Call `ota.check` after boot so an update queued while the device was offline
starts promptly.

### 3.6 Events

`d/<id>/up/evt/<name>` with a JSON body. The only event used today is `ota`
(section 4); unknown events are ignored.

## 4. OTA

1. **Request.** The device receives `ota.start` (on `d/<id>/down/req/ota/start`):

   ```json
   {
     "url": "https://iot.example.com/v1/device/firmware/<id>?d=<deviceId>&exp=…&sig=…",
     "sha256": "<sha256 of the image>",
     "size": 1048576,
     "version": "1.3.0",
     "taskId": "0199…"
   }
   ```

2. **Accept or refuse.** Respond `{ "ok": true }` to accept, or `{ "ok": false, "error": "…" }`
   (for example "battery low") to refuse. A refusal marks the task failed.
3. **Download.** Fetch the image with `esp_https_ota`. The URL is valid for one
   hour and supports `Range` requests, so an interrupted download can resume.
   Check the SHA-256 against `sha256`.
4. **Report progress.** Publish to `d/<id>/up/evt/ota`:

   ```json
   { "taskId": "0199…", "state": "downloading", "progress": 42 }
   { "taskId": "0199…", "state": "verifying" }
   { "taskId": "0199…", "state": "rebooting" }
   { "taskId": "0199…", "state": "failed", "error": "sha256 mismatch" }
   ```

5. **Finish.** After rebooting into the new image, the birth status's `fw.elfSha256`
   completes the task. If the device comes back with its old firmware (for
   example after a rollback), the task is marked failed.

A device works on one OTA task at a time.

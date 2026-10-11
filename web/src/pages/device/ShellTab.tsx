import { Alert, Box, CircularProgress, InputBase, Paper, Typography } from "@mui/material";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { api, errorMessage, unwrap, type Device } from "../../api/client";
import { mono } from "../../theme";

interface Entry {
  line: string;
  output?: string | null;
  code?: number | null;
  error?: string;
  pending?: boolean;
}

/** Debug console: each line is sent as a `shell` request and the device's output shown. */
export function ShellTab({ device }: { device: Device }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [cursor, setCursor] = useState(-1);
  const end = useRef<HTMLDivElement>(null);
  const busy = entries.some((e) => e.pending);

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [entries]);

  async function run(line: string) {
    const index = entries.length;
    setEntries((prev) => [...prev, { line, pending: true }]);
    setHistory((h) => [line, ...h.filter((x) => x !== line)].slice(0, 100));
    setCursor(-1);
    let entry: Entry;
    try {
      const res = await unwrap(api.POST("/v1/devices/{id}/shell", { params: { path: { id: device.id } }, body: { line, timeoutSec: 15 } }));
      const { command } = res;
      if (command.status === "succeeded") entry = { line, output: res.output, code: res.code };
      else if (command.status === "failed") entry = { line, error: command.error ?? "command failed" };
      else entry = { line, error: device.online ? "no answer within 15 s" : "device is offline; no answer within 15 s" };
    } catch (err) {
      entry = { line, error: errorMessage(err) };
    }
    setEntries((prev) => prev.map((e, i) => (i === index ? entry : e)));
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && input.trim() && !busy) {
      void run(input.trim());
      setInput("");
    } else if (e.key === "ArrowUp" && history.length) {
      e.preventDefault();
      const next = Math.min(cursor + 1, history.length - 1);
      setCursor(next);
      setInput(history[next]!);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const next = cursor - 1;
      setCursor(next);
      setInput(next < 0 ? "" : history[next]!);
    }
  }

  return (
    <>
      {!device.online && (
        <Alert severity="info" sx={{ mb: 2 }}>
          The device is offline. Commands are only answered while it is connected.
        </Alert>
      )}
      <Paper
        variant="outlined"
        sx={{ ...mono, fontSize: 13, bgcolor: "#1e1e1e", color: "#e0e0e0", p: 2, height: "calc(100vh - 320px)", minHeight: 300, overflow: "auto" }}
        onClick={() => document.getElementById("shell-input")?.focus()}
      >
        <Typography sx={{ ...mono, fontSize: 13, color: "#9e9e9e", mb: 1 }}>
          Remote shell for {device.name}. Commands are defined by the device firmware, e.g. “status uptime”. ↑/↓ for history.
        </Typography>
        {entries.map((e, i) => (
          <Box key={i} sx={{ mb: 1 }}>
            <Box>
              <span style={{ color: "#4db6ac" }}>{device.id}&gt;</span> {e.line}
            </Box>
            {e.pending && <CircularProgress size={12} sx={{ color: "#9e9e9e", mt: 0.5 }} />}
            {e.output != null && <Box sx={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{e.output}</Box>}
            {e.code != null && e.code !== 0 && <Box sx={{ color: "#ffb74d" }}>exit code {e.code}</Box>}
            {e.error && <Box sx={{ color: "#ef9a9a" }}>error: {e.error}</Box>}
          </Box>
        ))}
        <Box sx={{ display: "flex", alignItems: "center" }}>
          <span style={{ color: "#4db6ac", marginRight: 6, whiteSpace: "nowrap", flexShrink: 0 }}>{device.id}&gt;</span>
          <InputBase
            id="shell-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
            disabled={busy}
            autoFocus
            fullWidth
            spellCheck={false}
            autoComplete="off"
            inputProps={{ "aria-label": "Shell command", maxLength: 512 }}
            sx={{ ...mono, fontSize: 13, color: "inherit" }}
          />
        </Box>
        <div ref={end} />
      </Paper>
    </>
  );
}

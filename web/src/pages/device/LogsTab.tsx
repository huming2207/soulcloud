import DownloadIcon from "@mui/icons-material/Download";
import WarningIcon from "@mui/icons-material/WarningAmber";
import {
  Box,
  Button,
  FormControlLabel,
  MenuItem,
  Paper,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { api, authFetch, unwrap, type Device, type LogEntry } from "../../api/client";
import { readSse } from "../../api/sse";
import { ErrorAlert, LevelChip, Loading } from "../../components/common";
import { mono } from "../../theme";

type Level = "error" | "warn" | "info" | "debug" | "verbose";
type Kind = "text" | "bin";

const timeFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3 });

export function LogsTab({ device }: { device: Device }) {
  const [level, setLevel] = useState<Level | "">("");
  const [kind, setKind] = useState<Kind | "">("");
  const [live, setLive] = useState(true);
  const [liveEntries, setLiveEntries] = useState<LogEntry[]>([]);
  const [liveError, setLiveError] = useState<unknown>(null);
  const filter = { ...(level && { level }), ...(kind && { kind }) };

  const pages = useInfiniteQuery({
    queryKey: ["logs", device.id, level, kind],
    queryFn: ({ pageParam }) =>
      unwrap(api.GET("/v1/devices/{id}/logs", { params: { path: { id: device.id }, query: { ...filter, limit: 200, before: pageParam } } })),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  });

  // Live tail: new entries are prepended above the fetched pages.
  useEffect(() => {
    setLiveEntries([]);
    if (!live) return;
    const ctrl = new AbortController();
    const qs = new URLSearchParams(filter as Record<string, string>).toString();
    let retry: ReturnType<typeof setTimeout>;
    const connect = () => {
      setLiveError(null);
      readSse(
        `/v1/devices/${device.id}/logs/stream${qs ? `?${qs}` : ""}`,
        (e) => {
          if (e.event !== "log") return;
          const entry = JSON.parse(e.data) as LogEntry;
          setLiveEntries((prev) => [entry, ...prev].slice(0, 2000));
        },
        ctrl.signal,
      )
        .catch((err) => {
          if (ctrl.signal.aborted) return;
          setLiveError(err);
        })
        .finally(() => {
          if (!ctrl.signal.aborted) retry = setTimeout(connect, 3000);
        });
    };
    connect();
    return () => {
      ctrl.abort();
      clearTimeout(retry);
    };
  }, [device.id, live, level, kind]);

  const rows = useMemo(() => {
    const fetched = pages.data?.pages.flatMap((p) => p.items) ?? [];
    const seen = new Set(fetched.map((e) => e.id));
    return [...liveEntries.filter((e) => !seen.has(e.id)), ...fetched];
  }, [pages.data, liveEntries]);

  async function downloadRaw() {
    const res = await authFetch(`/v1/devices/${device.id}/logs/raw`);
    const url = URL.createObjectURL(await res.blob());
    const a = Object.assign(document.createElement("a"), { href: url, download: `${device.id}.on9log` });
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5} sx={{ mb: 2, alignItems: { sm: "center" } }}>
        <TextField select label="Level" slotProps={{ select: { displayEmpty: true }, inputLabel: { shrink: true } }} value={level} onChange={(e) => setLevel(e.target.value as Level | "")} sx={{ minWidth: 150 }}>
          <MenuItem value="">All levels</MenuItem>
          <MenuItem value="error">Errors</MenuItem>
          <MenuItem value="warn">Warnings and above</MenuItem>
          <MenuItem value="info">Info and above</MenuItem>
          <MenuItem value="debug">Debug and above</MenuItem>
        </TextField>
        <TextField select label="Source" slotProps={{ select: { displayEmpty: true }, inputLabel: { shrink: true } }} value={kind} onChange={(e) => setKind(e.target.value as Kind | "")} sx={{ minWidth: 150 }}>
          <MenuItem value="">Text and binary</MenuItem>
          <MenuItem value="text">Text</MenuItem>
          <MenuItem value="bin">Binary (on9log)</MenuItem>
        </TextField>
        <FormControlLabel control={<Switch checked={live} onChange={(e) => setLive(e.target.checked)} />} label="Live" />
        <Box sx={{ flexGrow: 1 }} />
        <Tooltip title="Binary logs as an on9log stream for the host CLI">
          <Button startIcon={<DownloadIcon />} onClick={() => void downloadRaw()}>
            Raw export
          </Button>
        </Tooltip>
      </Stack>
      <ErrorAlert error={pages.error} />
      {live && liveError ? <ErrorAlert error={liveError} /> : null}
      {pages.isPending ? (
        <Loading />
      ) : (
        <TableContainer component={Paper} variant="outlined" sx={{ maxHeight: "calc(100vh - 300px)" }}>
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                <TableCell sx={{ width: 190 }}>Time</TableCell>
                <TableCell sx={{ width: 90 }}>Level</TableCell>
                <TableCell sx={{ width: 140 }}>Tag</TableCell>
                <TableCell>Message</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((e) => (
                <TableRow key={e.id} hover>
                  <TableCell sx={{ whiteSpace: "nowrap", color: "text.secondary", verticalAlign: "top" }}>
                    <Tooltip title={e.deviceTimeMs != null ? `Device time ${e.deviceTimeMs} ms since boot` : ""}>
                      <span>{timeFmt.format(new Date(e.loggedAt ?? e.receivedAt))}</span>
                    </Tooltip>
                  </TableCell>
                  <TableCell sx={{ verticalAlign: "top" }}>
                    <LevelChip level={e.level} />
                  </TableCell>
                  <TableCell sx={{ ...mono, fontSize: 12, verticalAlign: "top", overflowWrap: "anywhere" }}>{e.tag ?? ""}</TableCell>
                  <TableCell sx={{ ...mono, fontSize: 12, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                    {!e.decoded && (
                      <Tooltip title="Not decoded: upload the ELF for this firmware to see the full message">
                        <WarningIcon color="warning" sx={{ fontSize: 14, mr: 0.5, verticalAlign: "text-bottom" }} />
                      </Tooltip>
                    )}
                    {e.message}
                  </TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4}>
                    <Typography variant="body2" color="text.secondary" sx={{ py: 3, textAlign: "center" }}>
                      No logs{live ? " yet — new entries appear here as they arrive" : ""}.
                    </Typography>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
      )}
      {pages.hasNextPage && (
        <Box sx={{ textAlign: "center", mt: 2 }}>
          <Button onClick={() => void pages.fetchNextPage()} loading={pages.isFetchingNextPage}>
            Load older
          </Button>
        </Box>
      )}
    </>
  );
}

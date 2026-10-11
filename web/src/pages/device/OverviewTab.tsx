import { Card, CardContent, CardHeader, Grid, Link, Typography } from "@mui/material";
import { LineChart } from "@mui/x-charts/LineChart";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link as RouterLink } from "react-router";
import { api, unwrap, type Device } from "../../api/client";
import { DeviceStatusChip, Facts } from "../../components/common";
import { formatBytes, formatDateTime, formatDuration, formatRelative, shortSha } from "../../format";
import { mono } from "../../theme";

interface Health {
  heap?: { free?: number; minFree?: number } | null;
  rssi?: number | null;
  extra?: Record<string, unknown> | null;
}

/** Uptime counted forward from the last heartbeat while the device is online. */
function useLiveUptime(device: Device) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!device.online) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [device.online]);
  if (device.uptimeMs == null) return null;
  if (!device.online || !device.lastSeenAt) return device.uptimeMs;
  return device.uptimeMs + Math.max(0, now - Date.parse(device.lastSeenAt));
}

export function OverviewTab({ device }: { device: Device }) {
  const uptime = useLiveUptime(device);
  const health = (device.health ?? {}) as Health;
  const heartbeats = useQuery({
    queryKey: ["heartbeats", device.id],
    queryFn: () => unwrap(api.GET("/v1/devices/{id}/heartbeats", { params: { path: { id: device.id }, query: { limit: 200 } } })),
    refetchInterval: 30_000,
  });
  const points = (heartbeats.data ?? [])
    .map((h) => ({ t: new Date(h.receivedAt), heap: ((h.data as Health).heap?.free ?? null) as number | null }))
    .filter((p) => p.heap !== null)
    .reverse();

  return (
    <Grid container spacing={2}>
      <Grid size={{ xs: 12, md: 6 }}>
        <Card sx={{ height: "100%" }}>
          <CardHeader title="Status" titleTypographyProps={{ variant: "subtitle1" }} />
          <CardContent sx={{ pt: 0 }}>
            <Facts
              rows={[
                ["State", <DeviceStatusChip device={device} />],
                ["Uptime", device.online ? formatDuration(uptime) : `${formatDuration(device.uptimeMs)} (at last report)`],
                ["Last seen", `${formatRelative(device.lastSeenAt)} · ${formatDateTime(device.lastSeenAt)}`],
                ["Connected", formatDateTime(device.lastConnectedAt)],
                ["Disconnected", formatDateTime(device.lastDisconnectedAt)],
                ["Last reset", device.resetReason ?? "—"],
                ["Boot ID", device.bootId ?? "—"],
              ]}
            />
          </CardContent>
        </Card>
      </Grid>
      <Grid size={{ xs: 12, md: 6 }}>
        <Card sx={{ height: "100%" }}>
          <CardHeader title="Hardware & firmware" titleTypographyProps={{ variant: "subtitle1" }} />
          <CardContent sx={{ pt: 0 }}>
            <Facts
              rows={[
                ["Platform", device.platform],
                ["Chip", device.chip ?? "—"],
                ["Hardware ID", <span style={mono}>{device.hardwareId}</span>],
                ["Firmware", device.fwVersion ?? "—"],
                [
                  "ELF SHA-256",
                  device.currentFirmwareId ? (
                    <Link component={RouterLink} to="/firmware" sx={mono}>
                      {shortSha(device.elfSha256)}
                    </Link>
                  ) : (
                    <span style={mono}>{shortSha(device.elfSha256)}</span>
                  ),
                ],
                ["Enrolled", formatDateTime(device.createdAt)],
              ]}
            />
          </CardContent>
        </Card>
      </Grid>
      <Grid size={{ xs: 12, md: 4 }}>
        <Card sx={{ height: "100%" }}>
          <CardHeader title="Health" titleTypographyProps={{ variant: "subtitle1" }} />
          <CardContent sx={{ pt: 0 }}>
            <Facts
              rows={[
                ["Free heap", formatBytes(health.heap?.free)],
                ["Minimum free heap", formatBytes(health.heap?.minFree)],
                ["Wi-Fi RSSI", health.rssi != null ? `${health.rssi} dBm` : "—"],
                ...Object.entries(health.extra ?? {}).map(([k, v]): [string, string] => [k, typeof v === "object" ? JSON.stringify(v) : String(v)]),
              ]}
            />
          </CardContent>
        </Card>
      </Grid>
      <Grid size={{ xs: 12, md: 8 }}>
        <Card sx={{ height: "100%" }}>
          <CardHeader title="Free heap" subheader="From recent heartbeats" titleTypographyProps={{ variant: "subtitle1" }} />
          <CardContent sx={{ pt: 0 }}>
            {points.length > 1 ? (
              <LineChart
                height={220}
                dataset={points}
                xAxis={[{ dataKey: "t", scaleType: "time" }]}
                yAxis={[{ valueFormatter: (v: number) => formatBytes(v), width: 80 }]}
                series={[{ dataKey: "heap", showMark: false, valueFormatter: (v) => formatBytes(v) }]}
                margin={{ left: 0, right: 16, top: 16, bottom: 0 }}
              />
            ) : (
              <Typography variant="body2" color="text.secondary">
                Not enough heartbeats with heap data yet.
              </Typography>
            )}
          </CardContent>
        </Card>
      </Grid>
    </Grid>
  );
}

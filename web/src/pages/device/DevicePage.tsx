import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import EditIcon from "@mui/icons-material/Edit";
import LinkOffIcon from "@mui/icons-material/LinkOff";
import RestartIcon from "@mui/icons-material/RestartAlt";
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography,
} from "@mui/material";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link as RouterLink, useNavigate, useParams } from "react-router";
import { api, unwrap, type Device } from "../../api/client";
import { ConfirmDialog, CopyButton, DeviceStatusChip, ErrorAlert, Loading } from "../../components/common";
import { mono } from "../../theme";
import { CommandsTab } from "./CommandsTab";
import { LogsTab } from "./LogsTab";
import { OtaTab } from "./OtaTab";
import { OverviewTab } from "./OverviewTab";
import { ShellTab } from "./ShellTab";

const TABS = ["overview", "logs", "shell", "commands", "ota"] as const;
type TabName = (typeof TABS)[number];
const LABELS: Record<TabName, string> = { overview: "Overview", logs: "Logs", shell: "Shell", commands: "Commands", ota: "OTA" };

export function useDevice(id: string) {
  return useQuery({
    queryKey: ["device", id],
    queryFn: () => unwrap(api.GET("/v1/devices/{id}", { params: { path: { id } } })),
    refetchInterval: 5000,
  });
}

export function DevicePage() {
  const { id = "", tab = "overview" } = useParams();
  const navigate = useNavigate();
  const device = useDevice(id);
  const current = (TABS as readonly string[]).includes(tab) ? (tab as TabName) : "overview";

  if (device.isPending) return <Loading />;
  if (!device.data) return <ErrorAlert error={device.error} />;
  const d = device.data;
  const active = d.status === "active";

  return (
    <>
      <Stack direction="row" spacing={1} sx={{ mb: 2, alignItems: "flex-start" }}>
        <IconButton component={RouterLink} to="/devices" aria-label="Back to devices" sx={{ mt: 0.25 }}>
          <ArrowBackIcon />
        </IconButton>
        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
          <Stack direction="row" spacing={1.5} sx={{ alignItems: "center", flexWrap: "wrap" }}>
            <Typography variant="h5" noWrap>
              {d.name}
            </Typography>
            <DeviceStatusChip device={d} />
          </Stack>
          <Stack direction="row" spacing={0.5} sx={{ alignItems: "center" }}>
            <Typography variant="body2" color="text.secondary" sx={mono}>
              {d.id}
            </Typography>
            <CopyButton value={d.id} label="Copy device ID" />
          </Stack>
        </Box>
        <DeviceActions device={d} />
      </Stack>
      <Tabs
        value={current}
        onChange={(_, v: TabName) => navigate(`/devices/${d.id}/${v === "overview" ? "" : v}`)}
        variant="scrollable"
        sx={{ borderBottom: 1, borderColor: "divider", mb: 3 }}
      >
        {TABS.map((t) => (
          <Tab key={t} value={t} label={LABELS[t]} disabled={!active && (t === "shell" || t === "commands")} />
        ))}
      </Tabs>
      {current === "overview" && <OverviewTab device={d} />}
      {current === "logs" && <LogsTab device={d} />}
      {current === "shell" && <ShellTab device={d} />}
      {current === "commands" && <CommandsTab device={d} />}
      {current === "ota" && <OtaTab device={d} />}
    </>
  );
}

function DeviceActions({ device }: { device: Device }) {
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<"rename" | "reboot" | "unpair" | null>(null);
  const [name, setName] = useState(device.name);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["device", device.id] });

  const rename = useMutation({
    mutationFn: () => unwrap(api.PATCH("/v1/devices/{id}", { params: { path: { id: device.id } }, body: { name } })),
    onSuccess: () => {
      setDialog(null);
      void refresh();
      void queryClient.invalidateQueries({ queryKey: ["devices"] });
    },
  });
  const reboot = useMutation({
    mutationFn: () =>
      unwrap(api.POST("/v1/devices/{id}/commands", { params: { path: { id: device.id }, query: { wait: 0 } }, body: { method: "reboot", params: {} } })),
    onSuccess: () => setDialog(null),
  });
  const unpair = useMutation({
    mutationFn: () => unwrap(api.DELETE("/v1/devices/{id}", { params: { path: { id: device.id } } })),
    onSuccess: () => {
      setDialog(null);
      void refresh();
    },
  });

  if (device.status !== "active") return null;
  return (
    <Stack direction="row" spacing={1} sx={{ flexShrink: 0 }}>
      <Button
        startIcon={<EditIcon />}
        onClick={() => {
          setName(device.name);
          setDialog("rename");
        }}
      >
        Rename
      </Button>
      <Button startIcon={<RestartIcon />} onClick={() => setDialog("reboot")}>
        Reboot
      </Button>
      <Button color="error" startIcon={<LinkOffIcon />} onClick={() => setDialog("unpair")}>
        Unpair
      </Button>

      <Dialog open={dialog === "rename"} onClose={() => setDialog(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Rename device</DialogTitle>
        <DialogContent>
          <ErrorAlert error={rename.error} />
          <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} fullWidth autoFocus sx={{ mt: 1 }} />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialog(null)}>Cancel</Button>
          <Button variant="contained" onClick={() => rename.mutate()} loading={rename.isPending} disabled={!name.trim()}>
            Save
          </Button>
        </DialogActions>
      </Dialog>
      <ConfirmDialog
        open={dialog === "reboot"}
        title="Reboot device?"
        message={device.online ? "The device restarts and reconnects." : "The device is offline; it reboots when it next connects (within 5 minutes)."}
        confirmLabel="Reboot"
        busy={reboot.isPending}
        error={reboot.error}
        onConfirm={() => reboot.mutate()}
        onClose={() => setDialog(null)}
      />
      <ConfirmDialog
        open={dialog === "unpair"}
        title="Unpair device?"
        message="Its credentials stop working immediately and it is disconnected. Logs and history are kept. To use it again, enroll it with a new pairing token."
        confirmLabel="Unpair"
        danger
        busy={unpair.isPending}
        error={unpair.error}
        onConfirm={() => unpair.mutate()}
        onClose={() => setDialog(null)}
      />
    </Stack>
  );
}

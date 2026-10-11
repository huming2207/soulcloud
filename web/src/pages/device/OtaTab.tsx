import UpdateIcon from "@mui/icons-material/SystemUpdateAlt";
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  LinearProgress,
  MenuItem,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from "@mui/material";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link as RouterLink } from "react-router";
import { api, unwrap, type Device } from "../../api/client";
import { ErrorAlert, StatusChip } from "../../components/common";
import { formatBytes, formatDateTime } from "../../format";

export function OtaTab({ device }: { device: Device }) {
  const [open, setOpen] = useState(false);
  const tasks = useQuery({
    queryKey: ["ota-tasks", device.id],
    queryFn: () => unwrap(api.GET("/v1/devices/{id}/ota-tasks", { params: { path: { id: device.id } } })),
    refetchInterval: 3000,
  });

  return (
    <>
      <Stack direction="row" sx={{ mb: 2, alignItems: "center", justifyContent: "space-between" }}>
        <Typography variant="body2" color="text.secondary">
          Running firmware: {device.fwVersion ?? "unknown"}
        </Typography>
        {device.status === "active" && (
          <Button variant="contained" startIcon={<UpdateIcon />} onClick={() => setOpen(true)}>
            Update firmware
          </Button>
        )}
      </Stack>
      <ErrorAlert error={tasks.error} />
      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Started</TableCell>
              <TableCell>Status</TableCell>
              <TableCell sx={{ width: 200 }}>Progress</TableCell>
              <TableCell>Error</TableCell>
              <TableCell>Job</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {(tasks.data ?? []).map((t) => (
              <TableRow key={t.id}>
                <TableCell>{formatDateTime(t.createdAt)}</TableCell>
                <TableCell>
                  <StatusChip status={t.status} />
                </TableCell>
                <TableCell>
                  <LinearProgress variant="determinate" value={t.progress} sx={{ height: 6, borderRadius: 3 }} />
                </TableCell>
                <TableCell>{t.error ?? ""}</TableCell>
                <TableCell>
                  <Button size="small" component={RouterLink} to={`/ota/${t.jobId}`}>
                    View
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {tasks.data?.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} sx={{ color: "text.secondary", textAlign: "center", py: 3 }}>
                  No updates yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </TableContainer>
      <UpdateDialog device={device} open={open} onClose={() => setOpen(false)} />
    </>
  );
}

function UpdateDialog({ device, open, onClose }: { device: Device; open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [firmwareId, setFirmwareId] = useState("");
  const firmware = useQuery({ queryKey: ["firmware"], queryFn: () => unwrap(api.GET("/v1/firmware", {})), enabled: open });
  const compatible = (firmware.data ?? []).filter((f) => f.platform === device.platform && (!device.chip || f.chip === device.chip));

  const start = useMutation({
    mutationFn: () => unwrap(api.POST("/v1/ota-jobs", { body: { firmwareId, deviceIds: [device.id] } })),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["ota-tasks", device.id] });
      onClose();
    },
  });

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Update firmware</DialogTitle>
      <DialogContent>
        <ErrorAlert error={start.error} />
        {compatible.length === 0 && firmware.isSuccess ? (
          <Typography variant="body2" color="text.secondary">
            No uploaded firmware matches this device ({device.chip ?? device.platform}). Upload one on the Firmware page first.
          </Typography>
        ) : (
          <TextField select fullWidth label="Firmware" value={firmwareId} onChange={(e) => setFirmwareId(e.target.value)} sx={{ mt: 1 }}>
            {compatible.map((f) => (
              <MenuItem key={f.id} value={f.id}>
                <Box>
                  {f.projectName} {f.version}
                  <Typography component="span" variant="body2" color="text.secondary" sx={{ ml: 1 }}>
                    {f.chip} · {formatBytes(f.size)} · {formatDateTime(f.createdAt)}
                  </Typography>
                </Box>
              </MenuItem>
            ))}
          </TextField>
        )}
        <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
          {device.online ? "The device starts downloading right away." : "The device is offline; the update starts when it next connects."}
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={!firmwareId} loading={start.isPending} onClick={() => start.mutate()}>
          Start update
        </Button>
      </DialogActions>
    </Dialog>
  );
}

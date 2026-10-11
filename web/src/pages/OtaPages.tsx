import AddIcon from "@mui/icons-material/Add";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import {
  Autocomplete,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  LinearProgress,
  Link,
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
import { useMemo, useState } from "react";
import { Link as RouterLink, useNavigate, useParams } from "react-router";
import { api, unwrap, type Device, type Firmware, type OtaJob } from "../api/client";
import { ConfirmDialog, ErrorAlert, Loading, PageHeader, StatusChip } from "../components/common";
import { formatDateTime } from "../format";
import { mono } from "../theme";

const DONE = new Set(["succeeded", "failed", "cancelled"]);

function summary(job: OtaJob) {
  const total = job.tasks.length;
  const succeeded = job.tasks.filter((t) => t.status === "succeeded").length;
  const failed = job.tasks.filter((t) => t.status === "failed").length;
  const finished = job.tasks.filter((t) => DONE.has(t.status)).length;
  return { total, succeeded, failed, finished, progress: total ? (job.tasks.reduce((s, t) => s + (DONE.has(t.status) ? 100 : t.progress), 0) / total) : 0 };
}

function useFirmwareIndex() {
  const firmware = useQuery({ queryKey: ["firmware"], queryFn: () => unwrap(api.GET("/v1/firmware", {})) });
  return useMemo(() => new Map((firmware.data ?? []).map((f) => [f.id, f])), [firmware.data]);
}

const fwLabel = (f: Firmware | undefined) => (f ? `${f.projectName} ${f.version} (${f.chip})` : "Unknown firmware");

export function OtaJobsPage() {
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const jobs = useQuery({ queryKey: ["ota-jobs"], queryFn: () => unwrap(api.GET("/v1/ota-jobs")), refetchInterval: 5000 });
  const firmware = useFirmwareIndex();

  return (
    <>
      <PageHeader
        title="OTA updates"
        subtitle="Firmware rollouts and their per-device progress"
        actions={
          <Button variant="contained" startIcon={<AddIcon />} onClick={() => setCreating(true)}>
            New rollout
          </Button>
        }
      />
      <ErrorAlert error={jobs.error} />
      {jobs.isPending ? (
        <Loading />
      ) : (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Created</TableCell>
                <TableCell>Firmware</TableCell>
                <TableCell>Devices</TableCell>
                <TableCell sx={{ width: 220 }}>Progress</TableCell>
                <TableCell>Note</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {(jobs.data ?? []).map((job) => {
                const s = summary(job);
                return (
                  <TableRow key={job.id} hover sx={{ cursor: "pointer" }} onClick={() => navigate(`/ota/${job.id}`)}>
                    <TableCell>{formatDateTime(job.createdAt)}</TableCell>
                    <TableCell>{fwLabel(firmware.get(job.firmwareId))}</TableCell>
                    <TableCell>
                      <Stack direction="row" spacing={0.5}>
                        <Chip size="small" label={`${s.succeeded}/${s.total} done`} color={s.succeeded === s.total ? "success" : "default"} variant="outlined" />
                        {s.failed > 0 && <Chip size="small" label={`${s.failed} failed`} color="error" variant="outlined" />}
                      </Stack>
                    </TableCell>
                    <TableCell>
                      <LinearProgress variant="determinate" value={s.progress} sx={{ height: 6, borderRadius: 3 }} />
                    </TableCell>
                    <TableCell sx={{ color: "text.secondary" }}>{job.note ?? ""}</TableCell>
                  </TableRow>
                );
              })}
              {jobs.data?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} sx={{ color: "text.secondary", textAlign: "center", py: 3 }}>
                    No rollouts yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
      )}
      <NewRolloutDialog open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

function NewRolloutDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [firmwareId, setFirmwareId] = useState("");
  const [devices, setDevices] = useState<Device[]>([]);
  const [note, setNote] = useState("");
  const firmware = useQuery({ queryKey: ["firmware"], queryFn: () => unwrap(api.GET("/v1/firmware", {})), enabled: open });
  const allDevices = useQuery({
    queryKey: ["devices", "active"],
    queryFn: () => unwrap(api.GET("/v1/devices", { params: { query: { status: "active", limit: 500 } } })),
    enabled: open,
  });
  const fw = firmware.data?.find((f) => f.id === firmwareId);
  const eligible = (allDevices.data ?? []).filter((d) => fw && d.platform === fw.platform && (!d.chip || d.chip === fw.chip));

  const create = useMutation({
    mutationFn: () => unwrap(api.POST("/v1/ota-jobs", { body: { firmwareId, deviceIds: devices.map((d) => d.id), ...(note && { note }) } })),
    onSuccess: (job) => {
      void queryClient.invalidateQueries({ queryKey: ["ota-jobs"] });
      close();
      navigate(`/ota/${job.id}`);
    },
  });
  function close() {
    setFirmwareId("");
    setDevices([]);
    setNote("");
    create.reset();
    onClose();
  }

  return (
    <Dialog open={open} onClose={close} maxWidth="sm" fullWidth>
      <DialogTitle>New rollout</DialogTitle>
      <DialogContent>
        <ErrorAlert error={create.error} />
        <Stack spacing={2.5} sx={{ pt: 1 }}>
          <TextField select label="Firmware" value={firmwareId} onChange={(e) => (setFirmwareId(e.target.value), setDevices([]))}>
            {(firmware.data ?? []).map((f) => (
              <MenuItem key={f.id} value={f.id}>
                {fwLabel(f)}
              </MenuItem>
            ))}
          </TextField>
          <Autocomplete
            multiple
            disabled={!fw}
            options={eligible}
            value={devices}
            onChange={(_, v) => setDevices(v)}
            getOptionLabel={(d) => `${d.name} (${d.id})`}
            isOptionEqualToValue={(a, b) => a.id === b.id}
            renderInput={(p) => (
              <TextField {...p} label="Devices" helperText={fw ? `${eligible.length} paired ${fw.chip} devices` : "Choose firmware first"} />
            )}
          />
          {fw && eligible.length > 0 && (
            <Box>
              <Button size="small" onClick={() => setDevices(eligible)}>
                Select all {eligible.length}
              </Button>
            </Box>
          )}
          <TextField label="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={close}>Cancel</Button>
        <Button variant="contained" disabled={!fw || devices.length === 0} loading={create.isPending} onClick={() => create.mutate()}>
          Start rollout
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function OtaJobPage() {
  const { id = "" } = useParams();
  const queryClient = useQueryClient();
  const [cancelling, setCancelling] = useState(false);
  const job = useQuery({
    queryKey: ["ota-job", id],
    queryFn: () => unwrap(api.GET("/v1/ota-jobs/{id}", { params: { path: { id } } })),
    refetchInterval: 3000,
  });
  const firmware = useFirmwareIndex();
  const cancel = useMutation({
    mutationFn: () => unwrap(api.POST("/v1/ota-jobs/{id}/cancel", { params: { path: { id } } })),
    onSuccess: () => {
      setCancelling(false);
      void queryClient.invalidateQueries({ queryKey: ["ota-job", id] });
    },
  });

  if (job.isPending) return <Loading />;
  if (!job.data) return <ErrorAlert error={job.error} />;
  const j = job.data;
  const s = summary(j);

  return (
    <>
      <Stack direction="row" spacing={1} sx={{ alignItems: "flex-start" }}>
        <IconButton component={RouterLink} to="/ota" aria-label="Back to rollouts" sx={{ mt: 0.25 }}>
          <ArrowBackIcon />
        </IconButton>
        <Box sx={{ flexGrow: 1 }}>
          <PageHeader
            title={fwLabel(firmware.get(j.firmwareId))}
            subtitle={`Started ${formatDateTime(j.createdAt)}${j.note ? ` · ${j.note}` : ""}`}
            actions={
              s.finished < s.total && (
                <Button color="error" onClick={() => setCancelling(true)}>
                  Cancel rollout
                </Button>
              )
            }
          />
        </Box>
      </Stack>
      <Card sx={{ mb: 2 }}>
        <CardContent>
          <Stack direction="row" spacing={3} sx={{ mb: 1 }}>
            <Typography variant="body2">{s.succeeded} succeeded</Typography>
            <Typography variant="body2" color={s.failed ? "error" : "text.secondary"}>
              {s.failed} failed
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {s.total - s.finished} in progress or waiting
            </Typography>
          </Stack>
          <LinearProgress variant="determinate" value={s.progress} sx={{ height: 8, borderRadius: 4 }} />
        </CardContent>
      </Card>
      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Device</TableCell>
              <TableCell>Status</TableCell>
              <TableCell sx={{ width: 200 }}>Progress</TableCell>
              <TableCell>Error</TableCell>
              <TableCell>Updated</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {j.tasks.map((t) => (
              <TableRow key={t.id}>
                <TableCell>
                  <Link component={RouterLink} to={`/devices/${t.deviceId}/ota`} sx={mono}>
                    {t.deviceId}
                  </Link>
                </TableCell>
                <TableCell>
                  <StatusChip status={t.status} />
                </TableCell>
                <TableCell>
                  <LinearProgress variant="determinate" value={t.progress} sx={{ height: 6, borderRadius: 3 }} />
                </TableCell>
                <TableCell>{t.error ?? ""}</TableCell>
                <TableCell>{formatDateTime(t.updatedAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      <ConfirmDialog
        open={cancelling}
        title="Cancel rollout?"
        message="Waiting and downloading devices stop. Devices already verifying or rebooting into the new image finish."
        confirmLabel="Cancel rollout"
        danger
        busy={cancel.isPending}
        error={cancel.error}
        onConfirm={() => cancel.mutate()}
        onClose={() => setCancelling(false)}
      />
    </>
  );
}

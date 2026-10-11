import CheckIcon from "@mui/icons-material/Check";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  Stack,
  Tooltip,
  Typography,
  type ChipProps,
} from "@mui/material";
import { useState, type ReactNode } from "react";
import { errorMessage, type Device } from "../api/client";

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <Stack direction={{ xs: "column", sm: "row" }} spacing={2} sx={{ mb: 3, alignItems: { sm: "center" }, justifyContent: "space-between" }}>
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="h5">{title}</Typography>
        {subtitle && (
          <Typography variant="body2" color="text.secondary">
            {subtitle}
          </Typography>
        )}
      </Box>
      {actions && <Stack direction="row" spacing={1}>{actions}</Stack>}
    </Stack>
  );
}

export function Loading() {
  return (
    <Box sx={{ display: "flex", justifyContent: "center", py: 6 }}>
      <CircularProgress size={28} />
    </Box>
  );
}

export function ErrorAlert({ error, sx }: { error: unknown; sx?: object }) {
  if (!error) return null;
  return (
    <Alert severity="error" sx={{ mb: 2, ...sx }}>
      {errorMessage(error)}
    </Alert>
  );
}

export function DeviceStatusChip({ device }: { device: Pick<Device, "status" | "online"> }) {
  if (device.status !== "active") return <Chip size="small" label={device.status === "revoked" ? "Unpaired" : "Superseded"} />;
  return <Chip size="small" color={device.online ? "success" : "default"} variant={device.online ? "filled" : "outlined"} label={device.online ? "Online" : "Offline"} />;
}

const STATUS_COLORS: Record<string, ChipProps["color"]> = {
  succeeded: "success",
  failed: "error",
  expired: "warning",
  cancelled: "default",
  queued: "default",
  pending: "default",
  sent: "info",
  downloading: "info",
  verifying: "info",
  rebooting: "info",
};

export function StatusChip({ status }: { status: string }) {
  return <Chip size="small" variant="outlined" color={STATUS_COLORS[status] ?? "default"} label={status} />;
}

const LEVEL_COLORS: Record<string, ChipProps["color"]> = { error: "error", warn: "warning", info: "info", debug: "default", verbose: "default" };

export function LevelChip({ level }: { level: string }) {
  return <Chip size="small" color={LEVEL_COLORS[level] ?? "default"} variant="outlined" label={level.toUpperCase()} sx={{ height: 20, fontSize: 11, fontWeight: 500 }} />;
}

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Tooltip title={done ? "Copied" : label}>
      <IconButton
        size="small"
        aria-label={label}
        onClick={async () => {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        }}
      >
        {done ? <CheckIcon fontSize="inherit" /> : <ContentCopyIcon fontSize="inherit" />}
      </IconButton>
    </Tooltip>
  );
}

export function ConfirmDialog(props: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  error?: unknown;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog open={props.open} onClose={props.onClose} maxWidth="xs" fullWidth>
      <DialogTitle>{props.title}</DialogTitle>
      <DialogContent>
        <ErrorAlert error={props.error} />
        <DialogContentText component="div">{props.message}</DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={props.onClose}>Cancel</Button>
        <Button variant="contained" color={props.danger ? "error" : "primary"} onClick={props.onConfirm} loading={props.busy}>
          {props.confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/** A label/value grid for detail cards. */
export function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <Box component="dl" sx={{ display: "grid", gridTemplateColumns: "max-content 1fr", columnGap: 3, rowGap: 1, m: 0 }}>
      {rows.map(([k, v]) => (
        <Box key={k} sx={{ display: "contents" }}>
          <Typography component="dt" variant="body2" color="text.secondary">
            {k}
          </Typography>
          <Typography component="dd" variant="body2" sx={{ m: 0, minWidth: 0, overflowWrap: "anywhere" }}>
            {v}
          </Typography>
        </Box>
      ))}
    </Box>
  );
}

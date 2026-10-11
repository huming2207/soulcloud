import { Alert, Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Stack, TextField, Typography } from "@mui/material";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { api, unwrap, type NewEnrollment } from "../api/client";
import { CopyButton, ErrorAlert } from "../components/common";
import { mono } from "../theme";

/** Creates a pairing token, shows it, and waits for the device to redeem it. */
export function AddDeviceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [ttl, setTtl] = useState(10);
  const [enrollment, setEnrollment] = useState<NewEnrollment | null>(null);
  const [now, setNow] = useState(Date.now());

  const create = useMutation({
    mutationFn: () => unwrap(api.POST("/v1/enrollments", { body: { deviceName: name || undefined, ttlMinutes: ttl } })),
    onSuccess: setEnrollment,
  });

  const expiresAt = enrollment ? new Date(enrollment.expiresAt).getTime() : 0;
  const expired = enrollment !== null && now >= expiresAt;

  // Poll until the device redeems the token.
  const status = useQuery({
    queryKey: ["enrollments"],
    queryFn: () => unwrap(api.GET("/v1/enrollments")),
    enabled: open && enrollment !== null && !expired,
    refetchInterval: 2000,
  });
  const redeemed = status.data?.find((e) => e.id === enrollment?.id && e.deviceId);

  useEffect(() => {
    if (!enrollment || redeemed) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [enrollment, redeemed]);

  function close() {
    setEnrollment(null);
    setName("");
    create.reset();
    onClose();
  }

  const left = Math.max(0, Math.round((expiresAt - now) / 1000));

  return (
    <Dialog open={open} onClose={close} maxWidth="sm" fullWidth>
      <DialogTitle>Add a device</DialogTitle>
      <DialogContent>
        {!enrollment && (
          <Stack spacing={2} sx={{ pt: 1 }}>
            <Typography variant="body2" color="text.secondary">
              Create a single-use pairing token, then give it to the device during provisioning. The device redeems it for its own MQTT
              credentials.
            </Typography>
            <ErrorAlert error={create.error} />
            <TextField label="Device name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
            <TextField
              label="Valid for (minutes)"
              type="number"
              value={ttl}
              onChange={(e) => setTtl(Math.min(1440, Math.max(1, Number(e.target.value) || 10)))}
              slotProps={{ htmlInput: { min: 1, max: 1440 } }}
            />
          </Stack>
        )}
        {enrollment && (
          <Stack spacing={2} sx={{ pt: 1 }}>
            <Typography variant="body2" color="text.secondary">
              Pairing token
            </Typography>
            <Box sx={{ display: "flex", alignItems: "center", gap: 1, p: 2, bgcolor: "action.hover", borderRadius: 1 }}>
              <Typography sx={{ ...mono, fontSize: 24, letterSpacing: 1, flexGrow: 1 }}>{enrollment.token}</Typography>
              <CopyButton value={enrollment.token} label="Copy token" />
            </Box>
            {redeemed ? (
              <Alert severity="success">Paired as {redeemed.deviceId}.</Alert>
            ) : expired ? (
              <Alert severity="warning">The token expired. Close this dialog and create a new one.</Alert>
            ) : (
              <Stack direction="row" spacing={1.5} sx={{ alignItems: "center" }}>
                <CircularProgress size={18} />
                <Typography variant="body2" color="text.secondary">
                  Waiting for the device… expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}
                </Typography>
              </Stack>
            )}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={close}>{enrollment ? "Close" : "Cancel"}</Button>
        {!enrollment && (
          <Button variant="contained" onClick={() => create.mutate()} loading={create.isPending}>
            Create token
          </Button>
        )}
        {redeemed && (
          <Button variant="contained" onClick={() => navigate(`/devices/${redeemed.deviceId}`)}>
            Open device
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}

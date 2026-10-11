import SendIcon from "@mui/icons-material/Send";
import {
  Autocomplete,
  Box,
  Button,
  Card,
  CardContent,
  CardHeader,
  Collapse,
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
import { Fragment, useState } from "react";
import { api, unwrap, type Command, type Device } from "../../api/client";
import { ErrorAlert, StatusChip } from "../../components/common";
import { formatDateTime } from "../../format";
import { mono } from "../../theme";

const json = (v: unknown) => (v == null ? "" : JSON.stringify(v, null, 2));

export function CommandsTab({ device }: { device: Device }) {
  const queryClient = useQueryClient();
  const [method, setMethod] = useState("info");
  const [params, setParams] = useState("{}");
  const [paramsError, setParamsError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const methods = useQuery({ queryKey: ["methods"], queryFn: () => unwrap(api.GET("/v1/methods")), staleTime: Infinity });
  const history = useQuery({
    queryKey: ["commands", device.id],
    queryFn: () => unwrap(api.GET("/v1/devices/{id}/commands", { params: { path: { id: device.id }, query: { limit: 100 } } })),
    refetchInterval: 5000,
  });

  const send = useMutation({
    mutationFn: (body: { method: string; params: Record<string, unknown> }) =>
      unwrap(api.POST("/v1/devices/{id}/commands", { params: { path: { id: device.id }, query: { wait: 15 } }, body })),
    onSuccess: (cmd) => {
      setExpanded(cmd.id);
      void queryClient.invalidateQueries({ queryKey: ["commands", device.id] });
    },
  });

  function submit() {
    let parsed: unknown;
    try {
      parsed = params.trim() ? JSON.parse(params) : {};
    } catch {
      setParamsError("Params must be valid JSON");
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      setParamsError("Params must be a JSON object");
      return;
    }
    setParamsError(null);
    send.mutate({ method: method.trim(), params: parsed as Record<string, unknown> });
  }

  const selected = methods.data?.find((m) => m.name === method);

  return (
    <Stack spacing={3}>
      <Card>
        <CardHeader title="Send a request" subheader="Delivered over MQTT 5 request/response; waits up to 15 s for the answer." slotProps={{ title: { variant: "subtitle1" } }} />
        <CardContent sx={{ pt: 0 }}>
          <ErrorAlert error={send.error} />
          <Stack direction={{ xs: "column", md: "row" }} spacing={2} sx={{ alignItems: { md: "flex-start" } }}>
            <Autocomplete
              freeSolo
              options={(methods.data ?? []).map((m) => m.name)}
              value={method}
              onInputChange={(_, v) => setMethod(v)}
              sx={{ minWidth: 220 }}
              renderInput={(p) => <TextField {...p} label="Method" helperText={selected?.description ?? "Custom method"} />}
            />
            <TextField
              label="Params (JSON)"
              value={params}
              onChange={(e) => setParams(e.target.value)}
              error={paramsError !== null}
              helperText={paramsError ?? " "}
              multiline
              minRows={2}
              fullWidth
              slotProps={{ htmlInput: { style: { ...mono, fontSize: 13 }, spellCheck: false } }}
            />
            <Button variant="contained" startIcon={<SendIcon />} onClick={submit} loading={send.isPending} disabled={!method.trim()} sx={{ flexShrink: 0 }}>
              Send
            </Button>
          </Stack>
        </CardContent>
      </Card>

      <Box>
        <Typography variant="subtitle1" sx={{ mb: 1 }}>
          History
        </Typography>
        <ErrorAlert error={history.error} />
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Method</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Requested</TableCell>
                <TableCell>Completed</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {(history.data ?? []).map((c: Command) => (
                <Fragment key={c.id}>
                  <TableRow hover sx={{ cursor: "pointer", "& > td": { borderBottom: expanded === c.id ? 0 : undefined } }} onClick={() => setExpanded(expanded === c.id ? null : c.id)}>
                    <TableCell sx={mono}>{c.method}</TableCell>
                    <TableCell>
                      <StatusChip status={c.status} />
                    </TableCell>
                    <TableCell>{formatDateTime(c.createdAt)}</TableCell>
                    <TableCell>{formatDateTime(c.completedAt)}</TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell colSpan={4} sx={{ py: 0 }}>
                      <Collapse in={expanded === c.id} unmountOnExit>
                        <Stack direction={{ xs: "column", md: "row" }} spacing={2} sx={{ py: 1.5 }}>
                          <Detail label="Params" value={json(c.params)} />
                          <Detail label={c.error ? "Error" : "Result"} value={c.error ?? json(c.result)} />
                        </Stack>
                      </Collapse>
                    </TableCell>
                  </TableRow>
                </Fragment>
              ))}
              {history.data?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} sx={{ color: "text.secondary", textAlign: "center", py: 3 }}>
                    No commands sent yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </Box>
    </Stack>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <Box sx={{ flex: 1, minWidth: 0 }}>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      <Box component="pre" sx={{ ...mono, fontSize: 12, m: 0, p: 1, bgcolor: "action.hover", borderRadius: 1, overflow: "auto", maxHeight: 300 }}>
        {value || "—"}
      </Box>
    </Box>
  );
}

import AddIcon from "@mui/icons-material/Add";
import DeleteIcon from "@mui/icons-material/DeleteOutlined";
import { Button, Chip, IconButton, Link, Paper, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Tooltip } from "@mui/material";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link as RouterLink } from "react-router";
import { api, unwrap, type Enrollment } from "../api/client";
import { ErrorAlert, Loading, PageHeader } from "../components/common";
import { formatDateTime } from "../format";
import { mono } from "../theme";
import { AddDeviceDialog } from "./AddDeviceDialog";

function state(e: Enrollment) {
  if (e.usedAt) return <Chip size="small" color="success" variant="outlined" label="Redeemed" />;
  if (Date.parse(e.expiresAt) < Date.now()) return <Chip size="small" variant="outlined" label="Expired" />;
  return <Chip size="small" color="info" variant="outlined" label="Waiting" />;
}

export function EnrollmentsPage() {
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const list = useQuery({ queryKey: ["enrollments"], queryFn: () => unwrap(api.GET("/v1/enrollments")), refetchInterval: 10_000 });
  const cancel = useMutation({
    mutationFn: (id: string) => unwrap(api.DELETE("/v1/enrollments/{id}", { params: { path: { id } } })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["enrollments"] }),
  });

  return (
    <>
      <PageHeader
        title="Enrollments"
        subtitle="Pairing tokens issued to new devices"
        actions={
          <Button variant="contained" startIcon={<AddIcon />} onClick={() => setAdding(true)}>
            New pairing token
          </Button>
        }
      />
      <ErrorAlert error={list.error ?? cancel.error} />
      {list.isPending ? (
        <Loading />
      ) : (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Created</TableCell>
                <TableCell>Device name</TableCell>
                <TableCell>State</TableCell>
                <TableCell>Expires</TableCell>
                <TableCell>Device</TableCell>
                <TableCell />
              </TableRow>
            </TableHead>
            <TableBody>
              {(list.data ?? []).map((e) => (
                <TableRow key={e.id}>
                  <TableCell>{formatDateTime(e.createdAt)}</TableCell>
                  <TableCell>{e.deviceName ?? "—"}</TableCell>
                  <TableCell>{state(e)}</TableCell>
                  <TableCell>{formatDateTime(e.expiresAt)}</TableCell>
                  <TableCell>
                    {e.deviceId ? (
                      <Link component={RouterLink} to={`/devices/${e.deviceId}`} sx={mono}>
                        {e.deviceId}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell align="right">
                    {!e.usedAt && (
                      <Tooltip title="Cancel token">
                        <IconButton size="small" onClick={() => cancel.mutate(e.id)}>
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {list.data?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} sx={{ color: "text.secondary", textAlign: "center", py: 3 }}>
                    No pairing tokens yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
      )}
      <AddDeviceDialog open={adding} onClose={() => setAdding(false)} />
    </>
  );
}

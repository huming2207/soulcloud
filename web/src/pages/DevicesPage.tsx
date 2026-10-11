import AddIcon from "@mui/icons-material/Add";
import { Button, Link, MenuItem, Paper, TextField } from "@mui/material";
import { DataGrid, type GridColDef } from "@mui/x-data-grid";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link as RouterLink } from "react-router";
import { api, unwrap, type Device } from "../api/client";
import { DeviceStatusChip, ErrorAlert, PageHeader } from "../components/common";
import { formatDuration, formatRelative } from "../format";
import { mono } from "../theme";
import { AddDeviceDialog } from "./AddDeviceDialog";

type StatusFilter = "active" | "revoked" | "superseded" | "all";

const columns: GridColDef<Device>[] = [
  { field: "online", headerName: "Status", width: 110, renderCell: (p) => <DeviceStatusChip device={p.row} /> },
  {
    field: "name",
    headerName: "Name",
    flex: 1,
    minWidth: 160,
    renderCell: (p) => (
      <Link component={RouterLink} to={`/devices/${p.row.id}`} underline="hover">
        {p.row.name}
      </Link>
    ),
  },
  { field: "id", headerName: "Device ID", width: 140, renderCell: (p) => <span style={mono}>{p.row.id}</span> },
  { field: "chip", headerName: "Chip", width: 110, valueGetter: (_v, row) => row.chip ?? row.platform },
  { field: "fwVersion", headerName: "Firmware", width: 120, valueGetter: (v) => v ?? "—" },
  { field: "uptimeMs", headerName: "Uptime", width: 120, valueFormatter: (v: number | null) => (v == null ? "—" : formatDuration(v)) },
  { field: "resetReason", headerName: "Last reset", width: 120, valueGetter: (v) => v ?? "—" },
  {
    field: "lastSeenAt",
    headerName: "Last seen",
    width: 150,
    valueFormatter: (v: string | null) => formatRelative(v),
    sortComparator: (a, b) => (a ? Date.parse(a) : 0) - (b ? Date.parse(b) : 0),
  },
];

export function DevicesPage() {
  const [status, setStatus] = useState<StatusFilter>("active");
  const [adding, setAdding] = useState(false);
  const devices = useQuery({
    queryKey: ["devices", status],
    queryFn: () => unwrap(api.GET("/v1/devices", { params: { query: { status, limit: 500 } } })),
    refetchInterval: 10_000,
  });

  return (
    <>
      <PageHeader
        title="Devices"
        subtitle={devices.data ? `${devices.data.filter((d) => d.online).length} of ${devices.data.length} online` : undefined}
        actions={
          <>
            <TextField select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} sx={{ minWidth: 140 }}>
              <MenuItem value="active">Paired</MenuItem>
              <MenuItem value="revoked">Unpaired</MenuItem>
              <MenuItem value="superseded">Superseded</MenuItem>
              <MenuItem value="all">All</MenuItem>
            </TextField>
            <Button variant="contained" startIcon={<AddIcon />} onClick={() => setAdding(true)}>
              Add device
            </Button>
          </>
        }
      />
      <ErrorAlert error={devices.error} />
      <Paper variant="outlined">
        <DataGrid
          rows={devices.data ?? []}
          columns={columns}
          loading={devices.isPending}
          density="compact"
          disableRowSelectionOnClick
          initialState={{ sorting: { sortModel: [{ field: "name", sort: "asc" }] }, pagination: { paginationModel: { pageSize: 50 } } }}
          pageSizeOptions={[25, 50, 100]}
          localeText={{ noRowsLabel: "No devices yet. Use “Add device” to pair one." }}
          sx={{ border: 0, minHeight: 300 }}
        />
      </Paper>
      <AddDeviceDialog open={adding} onClose={() => setAdding(false)} />
    </>
  );
}

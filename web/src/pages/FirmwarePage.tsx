import AttachIcon from "@mui/icons-material/AttachFile";
import DeleteIcon from "@mui/icons-material/DeleteOutlined";
import UploadIcon from "@mui/icons-material/Upload";
import {
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { DataGrid, type GridColDef } from "@mui/x-data-grid";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, authFetch, unwrap, type Firmware } from "../api/client";
import { ConfirmDialog, CopyButton, ErrorAlert, PageHeader } from "../components/common";
import { formatBytes, formatDateTime, shortSha } from "../format";
import { mono } from "../theme";

function FilePicker({ label, accept, file, onChange }: { label: string; accept: string; file: File | null; onChange: (f: File | null) => void }) {
  return (
    <Stack direction="row" spacing={1.5} sx={{ alignItems: "center" }}>
      <Button component="label" variant="outlined" startIcon={<AttachIcon />} sx={{ flexShrink: 0 }}>
        {label}
        <input hidden type="file" accept={accept} onChange={(e) => onChange(e.target.files?.[0] ?? null)} />
      </Button>
      <Typography variant="body2" color={file ? "text.primary" : "text.secondary"} noWrap>
        {file ? `${file.name} (${formatBytes(file.size)})` : "No file selected"}
      </Typography>
    </Stack>
  );
}

async function upload(path: string, method: string, form: FormData): Promise<Firmware> {
  const res = await authFetch(path, { method, body: form });
  return (await res.json()) as Firmware;
}

function UploadDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [bin, setBin] = useState<File | null>(null);
  const [elf, setElf] = useState<File | null>(null);
  const [notes, setNotes] = useState("");
  const mutation = useMutation({
    mutationFn: () => {
      const form = new FormData();
      form.set("bin", bin!);
      if (elf) form.set("elf", elf);
      if (notes) form.set("notes", notes);
      return upload("/v1/firmware", "POST", form);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["firmware"] });
      close();
    },
  });
  function close() {
    setBin(null);
    setElf(null);
    setNotes("");
    mutation.reset();
    onClose();
  }
  return (
    <Dialog open={open} onClose={close} maxWidth="sm" fullWidth>
      <DialogTitle>Upload firmware</DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ pt: 1 }}>
          <Typography variant="body2" color="text.secondary">
            Version, chip and build details are read from the application image. Add the matching ELF so binary logs from this firmware can
            be decoded; you can also attach it later.
          </Typography>
          <ErrorAlert error={mutation.error} sx={{ mb: 0 }} />
          <FilePicker label="Image (.bin)" accept=".bin,application/octet-stream" file={bin} onChange={setBin} />
          <FilePicker label="ELF (optional)" accept=".elf" file={elf} onChange={setElf} />
          <TextField label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} multiline minRows={2} />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={close}>Cancel</Button>
        <Button variant="contained" disabled={!bin} loading={mutation.isPending} onClick={() => mutation.mutate()}>
          Upload
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function FirmwarePage() {
  const queryClient = useQueryClient();
  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState<Firmware | null>(null);
  const [attaching, setAttaching] = useState<Firmware | null>(null);
  const firmware = useQuery({ queryKey: ["firmware"], queryFn: () => unwrap(api.GET("/v1/firmware", {})) });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["firmware"] });

  const remove = useMutation({
    mutationFn: (fw: Firmware) => unwrap(api.DELETE("/v1/firmware/{id}", { params: { path: { id: fw.id } } })),
    onSuccess: () => {
      setDeleting(null);
      void refresh();
    },
  });
  const attach = useMutation({
    mutationFn: ({ fw, file }: { fw: Firmware; file: File }) => {
      const form = new FormData();
      form.set("elf", file);
      return upload(`/v1/firmware/${fw.id}/elf`, "PUT", form);
    },
    onSuccess: () => {
      setAttaching(null);
      void refresh();
    },
  });

  const columns: GridColDef<Firmware>[] = [
    { field: "projectName", headerName: "Project", flex: 1, minWidth: 150 },
    { field: "version", headerName: "Version", width: 130 },
    { field: "chip", headerName: "Chip", width: 110 },
    { field: "size", headerName: "Size", width: 110, valueFormatter: (v: number) => formatBytes(v) },
    {
      field: "hasElf",
      headerName: "ELF",
      width: 100,
      renderCell: (p) => (p.row.hasElf ? <Chip size="small" label="Attached" color="success" variant="outlined" /> : <Chip size="small" label="Missing" variant="outlined" />),
    },
    {
      field: "elfSha256",
      headerName: "ELF SHA-256",
      width: 170,
      renderCell: (p) => (
        <Stack direction="row" sx={{ alignItems: "center" }}>
          <span style={mono}>{shortSha(p.row.elfSha256)}</span>
          <CopyButton value={p.row.elfSha256} label="Copy full hash" />
        </Stack>
      ),
    },
    { field: "sdkVersion", headerName: "SDK", width: 110, valueGetter: (v) => v ?? "—" },
    { field: "createdAt", headerName: "Uploaded", width: 190, valueFormatter: (v: string) => formatDateTime(v) },
    {
      field: "actions",
      headerName: "",
      width: 100,
      sortable: false,
      renderCell: (p) => (
        <>
          {!p.row.hasElf && (
            <Tooltip title="Attach ELF">
              <IconButton size="small" onClick={() => setAttaching(p.row)}>
                <AttachIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
          <Tooltip title="Delete">
            <IconButton size="small" onClick={() => setDeleting(p.row)}>
              <DeleteIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Firmware"
        subtitle="Application images for OTA updates, with ELFs for log decoding"
        actions={
          <Button variant="contained" startIcon={<UploadIcon />} onClick={() => setUploading(true)}>
            Upload
          </Button>
        }
      />
      <ErrorAlert error={firmware.error} />
      <Paper variant="outlined">
        <DataGrid
          rows={firmware.data ?? []}
          columns={columns}
          loading={firmware.isPending}
          density="compact"
          disableRowSelectionOnClick
          initialState={{ pagination: { paginationModel: { pageSize: 25 } } }}
          pageSizeOptions={[25, 50, 100]}
          localeText={{ noRowsLabel: "No firmware uploaded yet." }}
          sx={{ border: 0, minHeight: 300 }}
        />
      </Paper>
      <UploadDialog open={uploading} onClose={() => setUploading(false)} />
      <ConfirmDialog
        open={deleting !== null}
        title="Delete firmware?"
        message={deleting ? `${deleting.projectName} ${deleting.version} will be removed. Firmware used by an OTA job can't be deleted.` : ""}
        confirmLabel="Delete"
        danger
        busy={remove.isPending}
        error={remove.error}
        onConfirm={() => deleting && remove.mutate(deleting)}
        onClose={() => (setDeleting(null), remove.reset())}
      />
      <Dialog open={attaching !== null} onClose={() => (setAttaching(null), attach.reset())} maxWidth="sm" fullWidth>
        <DialogTitle>Attach ELF</DialogTitle>
        <DialogContent>
          <ErrorAlert error={attach.error} />
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Choose the ELF that {attaching?.projectName} {attaching?.version} was built from. Binary logs already received become readable.
          </Typography>
          <Button component="label" variant="contained" startIcon={<AttachIcon />} loading={attach.isPending}>
            Choose ELF
            <input hidden type="file" accept=".elf" onChange={(e) => attaching && e.target.files?.[0] && attach.mutate({ fw: attaching, file: e.target.files[0] })} />
          </Button>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => (setAttaching(null), attach.reset())}>Close</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

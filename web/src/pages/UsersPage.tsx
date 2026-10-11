import { MenuItem, Paper, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField } from "@mui/material";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, unwrap } from "../api/client";
import { useAuth } from "../auth";
import { ErrorAlert, Loading, PageHeader } from "../components/common";
import { formatDateTime } from "../format";

export function UsersPage() {
  const { user: me } = useAuth();
  const queryClient = useQueryClient();
  const users = useQuery({ queryKey: ["users"], queryFn: () => unwrap(api.GET("/v1/users")) });
  const setRole = useMutation({
    mutationFn: ({ id, role }: { id: string; role: "user" | "admin" }) => unwrap(api.PATCH("/v1/users/{id}", { params: { path: { id } }, body: { role } })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["users"] }),
  });

  return (
    <>
      <PageHeader title="Users" subtitle="Admins can see every device, firmware and rollout" />
      <ErrorAlert error={users.error ?? setRole.error} />
      {users.isPending ? (
        <Loading />
      ) : (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Email</TableCell>
                <TableCell>Name</TableCell>
                <TableCell>Joined</TableCell>
                <TableCell sx={{ width: 160 }}>Role</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {(users.data ?? []).map((u) => (
                <TableRow key={u.id}>
                  <TableCell>{u.email}</TableCell>
                  <TableCell>{u.name ?? "—"}</TableCell>
                  <TableCell>{formatDateTime(u.createdAt)}</TableCell>
                  <TableCell>
                    <TextField
                      select
                      value={u.role}
                      disabled={u.id === me?.id}
                      onChange={(e) => setRole.mutate({ id: u.id, role: e.target.value as "user" | "admin" })}
                      variant="standard"
                      fullWidth
                    >
                      <MenuItem value="user">User</MenuItem>
                      <MenuItem value="admin">Admin</MenuItem>
                    </TextField>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </>
  );
}

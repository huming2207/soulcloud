import { Box, Button, Card, CardContent, Stack, Tab, Tabs, TextField, Typography } from "@mui/material";
import { useState, type FormEvent } from "react";
import { Navigate } from "react-router";
import { useAuth } from "../auth";
import { ErrorAlert } from "../components/common";

export function LoginPage() {
  const { user, signIn, register } = useAuth();
  const [mode, setMode] = useState<"signin" | "register">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  if (user) return <Navigate to="/devices" replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "signin") await signIn(email, password);
      else await register(email, password, name || undefined);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Box sx={{ minHeight: "100vh", display: "grid", placeItems: "center", p: 2, bgcolor: "background.default" }}>
      <Card sx={{ width: "100%", maxWidth: 400 }}>
        <CardContent sx={{ p: 4 }}>
          <Typography variant="h5" color="primary" gutterBottom>
            SoulCloud
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Device management
          </Typography>
          <Tabs value={mode} onChange={(_, v) => setMode(v)} sx={{ mb: 3 }}>
            <Tab value="signin" label="Sign in" />
            <Tab value="register" label="Create account" />
          </Tabs>
          <ErrorAlert error={error} />
          <Stack component="form" spacing={2} onSubmit={submit}>
            {mode === "register" && <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />}
            <TextField label="Email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" autoFocus />
            <TextField
              label="Password"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === "signin" ? "current-password" : "new-password"}
              helperText={mode === "register" ? "At least 8 characters" : undefined}
              slotProps={{ htmlInput: { minLength: 8 } }}
            />
            <Button type="submit" variant="contained" size="large" loading={busy}>
              {mode === "signin" ? "Sign in" : "Create account"}
            </Button>
          </Stack>
        </CardContent>
      </Card>
    </Box>
  );
}

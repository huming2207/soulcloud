import DevicesIcon from "@mui/icons-material/DeveloperBoard";
import EnrollIcon from "@mui/icons-material/QrCode2";
import FirmwareIcon from "@mui/icons-material/Memory";
import LogoutIcon from "@mui/icons-material/Logout";
import MenuIcon from "@mui/icons-material/Menu";
import OtaIcon from "@mui/icons-material/SystemUpdateAlt";
import UsersIcon from "@mui/icons-material/People";
import {
  AppBar,
  Box,
  Drawer,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Toolbar,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import { useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router";
import { useAuth } from "../auth";

const DRAWER_WIDTH = 220;

const NAV = [
  { to: "/devices", label: "Devices", icon: <DevicesIcon /> },
  { to: "/firmware", label: "Firmware", icon: <FirmwareIcon /> },
  { to: "/ota", label: "OTA updates", icon: <OtaIcon /> },
  { to: "/enrollments", label: "Enrollments", icon: <EnrollIcon /> },
];

export function AppLayout() {
  const { user, signOut } = useAuth();
  const theme = useTheme();
  const wide = useMediaQuery(theme.breakpoints.up("md"));
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const items = user?.role === "admin" ? [...NAV, { to: "/users", label: "Users", icon: <UsersIcon /> }] : NAV;

  const drawer = (
    <>
      <Toolbar />
      <List dense sx={{ px: 1 }}>
        {items.map((item) => (
          <ListItemButton
            key={item.to}
            component={NavLink}
            to={item.to}
            selected={location.pathname.startsWith(item.to)}
            onClick={() => setOpen(false)}
            sx={{ borderRadius: 1, mb: 0.5 }}
          >
            <ListItemIcon sx={{ minWidth: 36 }}>{item.icon}</ListItemIcon>
            <ListItemText primary={item.label} />
          </ListItemButton>
        ))}
      </List>
    </>
  );

  return (
    <Box sx={{ display: "flex", minHeight: "100vh" }}>
      <AppBar position="fixed" color="inherit" sx={{ zIndex: (t) => t.zIndex.drawer + 1, borderBottom: 1, borderColor: "divider" }} elevation={0}>
        <Toolbar variant="dense">
          {!wide && (
            <IconButton edge="start" onClick={() => setOpen(true)} sx={{ mr: 1 }} aria-label="Open navigation">
              <MenuIcon />
            </IconButton>
          )}
          <Typography variant="h6" component="div" sx={{ flexGrow: 1, color: "primary.main" }}>
            SoulCloud
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mr: 1, display: { xs: "none", sm: "block" } }}>
            {user?.email}
          </Typography>
          <Tooltip title="Sign out">
            <IconButton onClick={() => void signOut()} aria-label="Sign out">
              <LogoutIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Toolbar>
      </AppBar>
      <Drawer
        variant={wide ? "permanent" : "temporary"}
        open={wide || open}
        onClose={() => setOpen(false)}
        sx={{ width: DRAWER_WIDTH, flexShrink: 0, "& .MuiDrawer-paper": { width: DRAWER_WIDTH, boxSizing: "border-box" } }}
      >
        {drawer}
      </Drawer>
      <Box component="main" sx={{ flexGrow: 1, minWidth: 0, p: { xs: 2, md: 3 } }}>
        <Toolbar variant="dense" />
        <Outlet />
      </Box>
    </Box>
  );
}

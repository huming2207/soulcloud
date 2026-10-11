import { createTheme } from "@mui/material/styles";

export const theme = createTheme({
  cssVariables: { colorSchemeSelector: "media" },
  colorSchemes: {
    light: { palette: { primary: { main: "#00695c" }, background: { default: "#f6f7f9" } } },
    dark: { palette: { primary: { main: "#4db6ac" } } },
  },
  shape: { borderRadius: 6 },
  typography: {
    fontFamily: "Roboto, system-ui, -apple-system, 'Segoe UI', sans-serif",
    h5: { fontWeight: 500 },
    h6: { fontWeight: 500 },
  },
  components: {
    MuiButton: { defaultProps: { disableElevation: true }, styleOverrides: { root: { textTransform: "none" } } },
    MuiTab: { styleOverrides: { root: { textTransform: "none" } } },
    MuiCard: { defaultProps: { variant: "outlined" } },
    MuiPaper: { defaultProps: { elevation: 0 } },
    MuiTableCell: { styleOverrides: { head: { fontWeight: 500 } } },
    MuiTextField: { defaultProps: { size: "small" } },
    MuiSelect: { defaultProps: { size: "small" } },
  },
});

export const mono = { fontFamily: "'Roboto Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" } as const;

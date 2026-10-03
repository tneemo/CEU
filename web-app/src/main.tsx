import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/theme.css";
import "./styles/app.css";
import "./styles/parity.css";
import "./styles/aero.css";
import "./styles/code.css";
import "./styles/agent.css";
import "./styles/nav.css";
import App from "./App.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

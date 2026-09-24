import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

/** React 挂载入口（web-first，后期由 Electron 加载同一份构建产物）。 */

const container = document.getElementById("root");
if (!container) {
  throw new Error("找不到 #root 挂载节点");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

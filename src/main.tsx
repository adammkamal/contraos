import React from "react";
import ReactDOM from "react-dom/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import App from "./App";
import "./styles.css";
const url = import.meta.env.VITE_CONVEX_URL;
const root = document.getElementById("root")!;
if (!url) {
  ReactDOM.createRoot(root).render(<div style={{background:"#07111e",color:"#e9f1ff",minHeight:"100vh",padding:40,fontFamily:"system-ui"}}><h1>ContraOS</h1><p>Convex is not configured. Set <code>VITE_CONVEX_URL</code> in <code>.env.local</code> from <code>npx convex dev</code>, then restart Vite.</p></div>);
} else {
  const client = new ConvexReactClient(url);
  ReactDOM.createRoot(root).render(<React.StrictMode><ConvexProvider client={client}><App/></ConvexProvider></React.StrictMode>);
}

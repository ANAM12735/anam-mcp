// --- Désactivation temporaire de l'auth pour debug ---
app.use("/mcp", (req, _res, next) => {
  // Log minimal pour vérifier ce que reçoit Render
  console.log("DEBUG AUTH header:", req.headers.authorization || "(none)");
  next(); // on laisse passer TOUT
});

// Endpoint debug (safe) : ne montre pas la valeur, juste s'il est défini
app.get("/debug-auth", (_req, res) => {
  const isSet = !!process.env.MCP_TOKEN && String(process.env.MCP_TOKEN).length > 0;
  res.json({ MCP_TOKEN_defined: isSet });
});

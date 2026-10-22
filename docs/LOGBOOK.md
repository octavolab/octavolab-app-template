# LOGBOOK · octavolab-app-template

Evidencia real por N70 (kit v7.0): corridas de CI y despliegues a staging. Una línea por evento verificable; nunca se edita una línea pasada, se añade una nueva.
Real evidence per N70 (kit v7.0): CI runs and staging deploys. One line per verifiable event; past lines are never edited, new ones are appended.

| Fecha / Date (UTC) | Evento / Event | Evidencia / Evidence |
|---|---|---|
| 2026-10-22 | Primera corrida real de CI en GitHub: falla (semgrep 19 hallazgos, trivy-action sin resolver, conflicto de pnpm) / First real CI run: failed | Run 39741290733, commit 5b9bf94 |
| 2026-10-22 | quality, security y semgrep en verde por primera vez; deploy-staging falla solo por falta del rol OIDC / first green checks | Run 39747164702 |
| 2026-10-22 | Lightsail staging creado en eu-west-2 (`octavolab-staging-db`, `octavolab-staging`, etiqueta `project=octavolab`), OIDC y rol `octavolab-deploy-staging`; secreto `AWS_ROLE_STAGING` y variable `STAGING_URL` en el entorno `staging` de GitHub | Configurado por Jaime en la consola de AWS; entorno de GitHub verificado en pantalla |
| 2026-10-22 | **Primer despliegue real a staging por OIDC, prueba de humo en verde** / first real staging deploy, smoke green | Run 39764207441, commit 359d343, job deploy-staging |
| 2026-10-22 | Salud de staging verificada desde el navegador / staging health checked | `GET https://octavolab-staging.759frm02vkhbg.eu-west-2.cs.amazonlightsail.com/api/health` → `{"ok":true,"version":"359d343","mode":"fake","deps":{"db":"ok","redis":"ok"}}` |
| 2026-10-22 | Interfaz web y E2E sembrado: E2E falla por `label-content-name-mismatch` (WCAG 2.5.3) y un falso positivo de gitleaks / web UI E2E failed on axe | Run 39765990915, commit 22cb797 |
| 2026-10-22 | pnpm audit antes de la corrección (22 oct 2026): @fastify/static high (<=10.1.0) y moderate; tinypool y vitest critical; vite high; esbuild moderate. Después de la corrección: "No known vulnerabilities found" / pnpm audit before and after the fix | Salida de `pnpm audit` en la sesión de ingeniería; corrección en commit 1e4cbfc; osv-scanner en verde desde la run 39747164702 |

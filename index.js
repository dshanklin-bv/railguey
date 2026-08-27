/**
 * Railguey — remote MCP server for Railway, hosted on Cloudflare Workers.
 * Streamable HTTP at /mcp (and /sse). Bearer auth via MCP_AUTH_TOKEN.
 * Railway GraphQL via RAILWAY_API_TOKEN (account or workspace token).
 */
const NAME = "railguey";
const VERSION = "1.0.0";
const GQL = "https://backboard.railway.com/graphql/v2";
const PROTOCOLS = ["2024-11-05", "2025-03-26", "2025-06-18", "2026-07-28"];
const DEFAULT_PROTOCOL = "2025-03-26";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Accept, Authorization, X-Api-Key, X-Railguey-Key, MCP-Session-Id, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "MCP-Session-Id, Mcp-Session-Id, MCP-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS,
      ...extra,
    },
  });
}

function text(body, status = 200, extra = {}) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", ...CORS, ...extra },
  });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", ...CORS },
  });
}

function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const aa = enc.encode(a);
  const bb = enc.encode(b);
  if (aa.byteLength !== bb.byteLength) {
    let acc = 0;
    for (let i = 0; i < aa.byteLength; i++) acc |= aa[i];
    return false;
  }
  let out = 0;
  for (let i = 0; i < aa.byteLength; i++) out |= aa[i] ^ bb[i];
  return out === 0;
}

function extractBearer(request, env) {
  const h = request.headers;
  const auth = h.get("Authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  const alt = h.get("X-Api-Key") || h.get("X-Railguey-Key") || "";
  if (alt) return alt.trim();
  const url = new URL(request.url);
  const q = url.searchParams.get("token");
  if (q && env.ALLOW_QUERY_TOKEN === "1") return q.trim();
  return "";
}

function authorized(request, env) {
  const expected = env.MCP_AUTH_TOKEN;
  if (!expected) return { ok: false, status: 503, error: "MCP_AUTH_TOKEN is not configured on this worker." };
  const got = extractBearer(request, env);
  if (!got || !timingSafeEqual(got, expected)) {
    return { ok: false, status: 401, error: "Unauthorized. Send Authorization: Bearer <MCP_AUTH_TOKEN>." };
  }
  return { ok: true };
}

async function railwayGql(token, query, variables) {
  if (!token) throw new Error("RAILWAY_API_TOKEN is not set. Paste a Railway account/workspace token in chat so it can be bound as a Worker secret.");
  const send = (headers) =>
    fetch(GQL, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ query, variables: variables || {} }),
    });
  let res = await send({ Authorization: `Bearer ${token}` });
  let payload = await res.json().catch(() => ({}));
  const failed = !res.ok || (payload.errors && payload.errors.length);
  if (failed && (res.status === 401 || res.status === 403)) {
    res = await send({ "Project-Access-Token": token });
    payload = await res.json().catch(() => ({}));
  }
  if (payload.errors && payload.errors.length) {
    throw new Error(payload.errors.map((e) => e.message).join("; "));
  }
  if (!res.ok) throw new Error(`Railway HTTP ${res.status}`);
  return payload.data;
}

function resultText(value, isError = false) {
  const textOut = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text: textOut }], isError };
}

function tool(name, description, properties, required, hints, run) {
  const inputSchema = { type: "object", properties: properties || {}, additionalProperties: false };
  if (required && required.length) inputSchema.required = required;
  return {
    name,
    description,
    inputSchema,
    annotations: {
      title: name,
      readOnlyHint: !!hints.readOnly,
      destructiveHint: !!hints.destructive,
      idempotentHint: !!hints.idempotent,
      openWorldHint: true,
    },
    run,
  };
}

const S = (desc) => ({ type: "string", description: desc });
const I = (desc) => ({ type: "integer", description: desc });
const B = (desc) => ({ type: "boolean", description: desc });

function makeTools(env) {
  const gql = (q, v) => railwayGql(env.RAILWAY_API_TOKEN, q, v);
  return [
    tool("whoami", "Return Railway identity for the configured token. Falls back to project access if the token cannot query me.", {}, [], { readOnly: true, idempotent: true }, async () => {
      try {
        const data = await gql(`query { me { id name email } }`);
        return data.me;
      } catch (err) {
        const data = await gql(`query { projects { edges { node { id name } } } }`);
        return {
          note: "This token cannot query `me` (typical of workspace/project tokens). Showing accessible projects instead.",
          error: String(err.message || err),
          projects: (data.projects?.edges || []).map((e) => e.node),
        };
      }
    }),
    tool("project_list", "List Railway projects visible to the token, including environments and services.", {}, [], { readOnly: true, idempotent: true }, async () => {
      const data = await gql(`
        query {
          projects {
            edges {
              node {
                id name description createdAt updatedAt isPublic teamId baseEnvironmentId
                environments { edges { node { id name } } }
                services { edges { node { id name } } }
              }
            }
          }
        }`);
      return (data.projects?.edges || []).map((e) => e.node);
    }),
    tool("project_info", "Get one Railway project with environments and services.", { projectId: S("Project ID") }, ["projectId"], { readOnly: true, idempotent: true }, async ({ projectId }) => {
      const data = await gql(
        `query project($id: String!) {
          project(id: $id) {
            id name description createdAt updatedAt isPublic teamId baseEnvironmentId
            environments { edges { node { id name createdAt isEphemeral } } }
            services { edges { node { id name createdAt icon } } }
          }
        }`,
        { id: projectId },
      );
      if (!data.project) throw new Error("Project not found");
      return data.project;
    }),
    tool("project_create", "Create a Railway project. Optional workspace/team ID.", { name: S("Project name"), teamId: S("Workspace/team ID") }, ["name"], { idempotent: false }, async ({ name, teamId }) => {
      const data = await gql(
        `mutation projectCreate($name: String!, $teamId: String) {
          projectCreate(input: { name: $name, teamId: $teamId }) {
            id name
            environments { edges { node { id name } } }
          }
        }`,
        { name, teamId: teamId || null },
      );
      return data.projectCreate;
    }),
    tool("project_delete", "DESTRUCTIVE. Permanently delete a Railway project.", { projectId: S("Project ID") }, ["projectId"], { destructive: true }, async ({ projectId }) => {
      await gql(`mutation projectDelete($id: String!) { projectDelete(id: $id) }`, { id: projectId });
      return { deleted: true, projectId };
    }),
    tool("project_environments", "List environments in a project.", { projectId: S("Project ID") }, ["projectId"], { readOnly: true, idempotent: true }, async ({ projectId }) => {
      const data = await gql(
        `query environments($projectId: String!) {
          environments(projectId: $projectId) {
            edges { node { id name projectId createdAt updatedAt isEphemeral unmergedChangesCount } }
          }
        }`,
        { projectId },
      );
      return (data.environments?.edges || []).map((e) => e.node);
    }),
    tool("environment_create", "Create an environment. Optionally clone from sourceEnvironmentId.", {
      projectId: S("Project ID"),
      name: S("Environment name"),
      sourceEnvironmentId: S("Environment to copy from"),
      ephemeral: B("Create as ephemeral"),
    }, ["projectId", "name"], { idempotent: false }, async ({ projectId, name, sourceEnvironmentId, ephemeral }) => {
      const data = await gql(
        `mutation environmentCreate($input: EnvironmentCreateInput!) {
          environmentCreate(input: $input) { id name }
        }`,
        { input: { projectId, name, sourceEnvironmentId: sourceEnvironmentId || undefined, ephemeral: ephemeral ?? undefined } },
      );
      return data.environmentCreate;
    }),
    tool("environment_delete", "DESTRUCTIVE. Delete an environment.", { environmentId: S("Environment ID") }, ["environmentId"], { destructive: true }, async ({ environmentId }) => {
      await gql(`mutation environmentDelete($id: String!) { environmentDelete(id: $id) }`, { id: environmentId });
      return { deleted: true, environmentId };
    }),
    tool("service_list", "List services in a project, with recent deployments.", { projectId: S("Project ID") }, ["projectId"], { readOnly: true, idempotent: true }, async ({ projectId }) => {
      const data = await gql(
        `query project($id: String!) {
          project(id: $id) {
            services {
              edges {
                node {
                  id name createdAt icon
                  deployments(first: 5) {
                    edges { node { id status createdAt environmentId staticUrl } }
                  }
                }
              }
            }
          }
        }`,
        { id: projectId },
      );
      return (data.project?.services?.edges || []).map((e) => e.node);
    }),
    tool("service_info", "Get a service and its instance config for an environment.", {
      serviceId: S("Service ID"),
      environmentId: S("Environment ID"),
    }, ["serviceId", "environmentId"], { readOnly: true, idempotent: true }, async ({ serviceId, environmentId }) => {
      const data = await gql(
        `query serviceInfo($id: String!, $serviceId: String!, $environmentId: String!) {
          service(id: $id) { id name icon createdAt projectId }
          serviceInstance(serviceId: $serviceId, environmentId: $environmentId) {
            id serviceName startCommand buildCommand rootDirectory healthcheckPath
            region numReplicas restartPolicyType latestDeployment { id status createdAt url staticUrl }
          }
        }`,
        { id: serviceId, serviceId, environmentId },
      );
      return data;
    }),
    tool("service_create", "Create a service from a GitHub repo (owner/repo or URL), a Docker image, or empty.", {
      projectId: S("Project ID"),
      name: S("Service name"),
      repo: S("GitHub repo, owner/repo or https URL"),
      branch: S("Git branch"),
      image: S("Docker image, e.g. nginx:latest"),
    }, ["projectId"], { idempotent: false }, async ({ projectId, name, repo, branch, image }) => {
      let source;
      if (image) source = { image };
      else if (repo) {
        const cleaned = String(repo).replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/, "").replace(/\/$/, "");
        source = { repo: cleaned, ...(branch ? { branch } : {}) };
      }
      const data = await gql(
        `mutation serviceCreate($projectId: String!, $name: String, $source: ServiceSourceInput) {
          serviceCreate(input: { projectId: $projectId, name: $name, source: $source }) {
            id name projectId createdAt
          }
        }`,
        { projectId, name: name || null, source: source || null },
      );
      return data.serviceCreate;
    }),
    tool("service_update", "Update service instance settings (build/start command, replicas, region, healthcheck).", {
      serviceId: S("Service ID"),
      environmentId: S("Environment ID"),
      buildCommand: S("Build command"),
      startCommand: S("Start command"),
      rootDirectory: S("Root directory"),
      healthcheckPath: S("Healthcheck path"),
      numReplicas: I("Replica count"),
      region: S("Region code"),
    }, ["serviceId", "environmentId"], { idempotent: true }, async (args) => {
      const { serviceId, environmentId, ...rest } = args;
      const input = {};
      for (const [k, v] of Object.entries(rest)) if (v !== undefined && v !== null && v !== "") input[k] = v;
      const data = await gql(
        `mutation serviceInstanceUpdate($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) {
          serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
        }`,
        { serviceId, environmentId, input },
      );
      return { updated: data.serviceInstanceUpdate, serviceId, environmentId, input };
    }),
    tool("service_delete", "DESTRUCTIVE. Delete a service from its project.", { serviceId: S("Service ID") }, ["serviceId"], { destructive: true }, async ({ serviceId }) => {
      await gql(`mutation serviceDelete($id: String!) { serviceDelete(id: $id) }`, { id: serviceId });
      return { deleted: true, serviceId };
    }),
    tool("service_redeploy", "Redeploy the current instance of a service in an environment.", {
      serviceId: S("Service ID"),
      environmentId: S("Environment ID"),
    }, ["serviceId", "environmentId"], { idempotent: false }, async ({ serviceId, environmentId }) => {
      const data = await gql(
        `mutation serviceInstanceRedeploy($serviceId: String!, $environmentId: String!) {
          serviceInstanceRedeploy(serviceId: $serviceId, environmentId: $environmentId)
        }`,
        { serviceId, environmentId },
      );
      return { redeployed: data.serviceInstanceRedeploy, serviceId, environmentId };
    }),
    tool("service_deploy", "Trigger a new deploy, optionally at a commit SHA.", {
      serviceId: S("Service ID"),
      environmentId: S("Environment ID"),
      commitSha: S("Git commit SHA"),
    }, ["serviceId", "environmentId"], { idempotent: false }, async ({ serviceId, environmentId, commitSha }) => {
      const data = await gql(
        `mutation serviceInstanceDeployV2($serviceId: String!, $environmentId: String!, $commitSha: String) {
          serviceInstanceDeployV2(serviceId: $serviceId, environmentId: $environmentId, commitSha: $commitSha)
        }`,
        { serviceId, environmentId, commitSha: commitSha || null },
      );
      return { deploymentId: data.serviceInstanceDeployV2 };
    }),
    tool("deployment_list", "List recent deployments for a service.", {
      projectId: S("Project ID"),
      serviceId: S("Service ID"),
      environmentId: S("Environment ID"),
      limit: I("Max deployments, default 10"),
    }, ["projectId", "serviceId"], { readOnly: true, idempotent: true }, async ({ projectId, serviceId, environmentId, limit }) => {
      const data = await gql(
        `query deployments($input: DeploymentListInput!, $first: Int) {
          deployments(input: $input, first: $first) {
            edges { node { id status createdAt url staticUrl serviceId environmentId canRedeploy canRollback } }
          }
        }`,
        { input: { projectId, serviceId, environmentId: environmentId || undefined }, first: limit || 10 },
      );
      return (data.deployments?.edges || []).map((e) => e.node);
    }),
    tool("deployment_info", "Get one deployment by ID.", { deploymentId: S("Deployment ID") }, ["deploymentId"], { readOnly: true, idempotent: true }, async ({ deploymentId }) => {
      const data = await gql(
        `query deployment($id: String!) {
          deployment(id: $id) {
            id status createdAt url staticUrl meta canRedeploy canRollback serviceId environmentId projectId
          }
        }`,
        { id: deploymentId },
      );
      if (!data.deployment) throw new Error("Deployment not found");
      return data.deployment;
    }),
    tool("deployment_logs", "Fetch runtime logs for a deployment.", {
      deploymentId: S("Deployment ID"),
      limit: I("Line cap, default 200"),
    }, ["deploymentId"], { readOnly: true }, async ({ deploymentId, limit }) => {
      const data = await gql(
        `query deploymentLogs($deploymentId: String!, $limit: Int) {
          deploymentLogs(deploymentId: $deploymentId, limit: $limit) { timestamp message severity }
        }`,
        { deploymentId, limit: limit || 200 },
      );
      return data.deploymentLogs || [];
    }),
    tool("deployment_build_logs", "Fetch build logs for a deployment.", {
      deploymentId: S("Deployment ID"),
      limit: I("Line cap, default 200"),
    }, ["deploymentId"], { readOnly: true }, async ({ deploymentId, limit }) => {
      const data = await gql(
        `query buildLogs($deploymentId: String!, $limit: Int) {
          buildLogs(deploymentId: $deploymentId, limit: $limit) { timestamp message severity }
        }`,
        { deploymentId, limit: limit || 200 },
      );
      return data.buildLogs || [];
    }),
    tool("deployment_restart", "Restart a running deployment.", { deploymentId: S("Deployment ID") }, ["deploymentId"], {}, async ({ deploymentId }) => {
      await gql(`mutation deploymentRestart($id: String!) { deploymentRestart(id: $id) }`, { id: deploymentId });
      return { restarted: true, deploymentId };
    }),
    tool("deployment_rollback", "DESTRUCTIVE. Roll a service back to this deployment.", { deploymentId: S("Deployment ID") }, ["deploymentId"], { destructive: true }, async ({ deploymentId }) => {
      const data = await gql(
        `mutation deploymentRollback($id: String!) { deploymentRollback(id: $id) { id status } }`,
        { id: deploymentId },
      );
      return data.deploymentRollback;
    }),
    tool("deployment_stop", "Stop a running deployment.", { deploymentId: S("Deployment ID") }, ["deploymentId"], { destructive: true }, async ({ deploymentId }) => {
      await gql(`mutation deploymentStop($id: String!) { deploymentStop(id: $id) }`, { id: deploymentId });
      return { stopped: true, deploymentId };
    }),
    tool("deployment_cancel", "Cancel an in-progress deployment.", { deploymentId: S("Deployment ID") }, ["deploymentId"], { destructive: true }, async ({ deploymentId }) => {
      await gql(`mutation deploymentCancel($id: String!) { deploymentCancel(id: $id) }`, { id: deploymentId });
      return { cancelled: true, deploymentId };
    }),
    tool("variable_list", "List variables for a service or shared environment.", {
      projectId: S("Project ID"),
      environmentId: S("Environment ID"),
      serviceId: S("Service ID; omit for shared env vars"),
    }, ["projectId", "environmentId"], { readOnly: true, idempotent: true }, async ({ projectId, environmentId, serviceId }) => {
      const data = await gql(
        `query variables($projectId: String!, $environmentId: String!, $serviceId: String) {
          variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId)
        }`,
        { projectId, environmentId, serviceId: serviceId || null },
      );
      return data.variables || {};
    }),
    tool("variable_set", "Create or update a variable. Does not print the value back.", {
      projectId: S("Project ID"),
      environmentId: S("Environment ID"),
      serviceId: S("Service ID; omit for shared"),
      name: S("Variable name"),
      value: S("Variable value"),
    }, ["projectId", "environmentId", "name", "value"], { idempotent: true }, async ({ projectId, environmentId, serviceId, name, value }) => {
      await gql(
        `mutation variableUpsert($input: VariableUpsertInput!) { variableUpsert(input: $input) }`,
        { input: { projectId, environmentId, serviceId: serviceId || undefined, name, value } },
      );
      return { upserted: true, name, serviceId: serviceId || null };
    }),
    tool("variable_delete", "Delete a variable.", {
      projectId: S("Project ID"),
      environmentId: S("Environment ID"),
      serviceId: S("Service ID; omit for shared"),
      name: S("Variable name"),
    }, ["projectId", "environmentId", "name"], { destructive: true }, async ({ projectId, environmentId, serviceId, name }) => {
      await gql(
        `mutation variableDelete($input: VariableDeleteInput!) { variableDelete(input: $input) }`,
        { input: { projectId, environmentId, serviceId: serviceId || undefined, name } },
      );
      return { deleted: true, name };
    }),
    tool("domain_list", "List custom and service domains for a service instance.", {
      projectId: S("Project ID"),
      environmentId: S("Environment ID"),
      serviceId: S("Service ID"),
    }, ["projectId", "environmentId", "serviceId"], { readOnly: true, idempotent: true }, async ({ projectId, environmentId, serviceId }) => {
      const data = await gql(
        `query domains($projectId: String!, $environmentId: String!, $serviceId: String!) {
          domains(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) {
            customDomains { id domain environmentId serviceId targetPort }
            serviceDomains { id domain suffix environmentId serviceId targetPort }
          }
        }`,
        { projectId, environmentId, serviceId },
      );
      return data.domains;
    }),
    tool("domain_create", "Create a Railway-provided *.up.railway.app service domain.", {
      environmentId: S("Environment ID"),
      serviceId: S("Service ID"),
      targetPort: I("Container port to target"),
    }, ["environmentId", "serviceId"], { idempotent: false }, async ({ environmentId, serviceId, targetPort }) => {
      const data = await gql(
        `mutation serviceDomainCreate($input: ServiceDomainCreateInput!) {
          serviceDomainCreate(input: $input) { id domain suffix environmentId serviceId targetPort }
        }`,
        { input: { environmentId, serviceId, targetPort: targetPort ?? undefined } },
      );
      return data.serviceDomainCreate;
    }),
    tool("domain_delete", "Delete a service domain by ID.", { domainId: S("Service domain ID") }, ["domainId"], { destructive: true }, async ({ domainId }) => {
      await gql(`mutation serviceDomainDelete($id: String!) { serviceDomainDelete(id: $id) }`, { id: domainId });
      return { deleted: true, domainId };
    }),
    tool("railway_graphql", "Escape hatch: run a raw GraphQL query or mutation against Railway. Prefer named tools.", {
      query: S("GraphQL document"),
      variablesJson: S("JSON object of variables"),
    }, ["query"], {}, async ({ query, variablesJson }) => {
      let variables = {};
      if (variablesJson) {
        try { variables = JSON.parse(variablesJson); }
        catch { throw new Error("variablesJson must be a JSON object string"); }
      }
      return gql(query, variables);
    }),
  ];
}

function publicToolList(tools) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: t.annotations,
  }));
}

function pickProtocol(requested) {
  if (requested && PROTOCOLS.includes(requested)) return requested;
  return DEFAULT_PROTOCOL;
}

async function handleRpc(msg, env, tools) {
  if (!msg || typeof msg !== "object") return null;
  const { id, method, params } = msg;
  const isNote = id === undefined || id === null;
  if (!method) return null;

  if (method === "notifications/initialized" || method === "notifications/cancelled") return null;
  if (isNote) return null;

  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

  try {
    switch (method) {
      case "initialize": {
        const requested = params?.protocolVersion;
        return ok({
          protocolVersion: pickProtocol(requested),
          capabilities: { tools: { listChanged: false }, resources: {}, prompts: {}, logging: {} },
          serverInfo: { name: NAME, version: VERSION, title: "Railguey" },
          instructions:
            "Railguey is a Railway MCP bridge. Start with project_list, then service_list / deployment_list. Destructive tools are marked. Railway token is stored as a Cloudflare Worker secret, never returned.",
        });
      }
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools: publicToolList(tools) });
      case "tools/call": {
        const name = params?.name;
        const args = params?.arguments || {};
        const found = tools.find((t) => t.name === name);
        if (!found) return ok(resultText(`Unknown tool: ${name}`, true));
        const missing = (found.inputSchema.required || []).filter((k) => args[k] === undefined || args[k] === null || args[k] === "");
        if (missing.length) return ok(resultText(`Missing required arguments: ${missing.join(", ")}`, true));
        try {
          const out = await found.run(args);
          return ok(resultText(out));
        } catch (err) {
          return ok(resultText(String(err.message || err), true));
        }
      }
      case "resources/list":
        return ok({ resources: [] });
      case "resources/templates/list":
        return ok({ resourceTemplates: [] });
      case "prompts/list":
        return ok({ prompts: [] });
      case "logging/setLevel":
        return ok({});
      default:
        return fail(-32601, `Method not found: ${method}`);
    }
  } catch (err) {
    return fail(-32603, String(err.message || err));
  }
}

function landingPage(env) {
  const railway = env.RAILWAY_API_TOKEN ? "bound" : "missing";
  const auth = env.MCP_AUTH_TOKEN ? "required" : "unconfigured";
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Railguey</title>
<style>
  :root { --bg:#0c0d0b; --fg:#e8e6df; --muted:#8b8a82; --line:rgba(232,230,223,.12); --ok:#7d9a78; }
  html,body { margin:0; background:var(--bg); color:var(--fg); font: 15px/1.5 "IBM Plex Sans", ui-sans-serif, system-ui, sans-serif; }
  main { max-width: 720px; margin: 0 auto; padding: 48px 24px 80px; }
  .lamp { width:10px; height:10px; border-radius:99px; background:var(--ok); box-shadow:0 0 0 4px rgba(125,154,120,.18); display:inline-block; }
  h1 { font: 600 42px/1.05 "Syne", "Avenir Next", sans-serif; letter-spacing:-.03em; margin: 18px 0 8px; }
  p { color: var(--muted); max-width: 52ch; }
  .row { display:flex; gap:24px; flex-wrap:wrap; margin: 28px 0; padding: 18px 0; border-top:1px solid var(--line); border-bottom:1px solid var(--line); }
  .k { font-size:11px; letter-spacing:.14em; text-transform:uppercase; color:var(--muted); }
  .v { font-variant-numeric: tabular-nums; margin-top:4px; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; color: var(--fg); }
</style>
<body>
<main>
  <span class="lamp" aria-hidden="true"></span>
  <h1>Railguey</h1>
  <p>Remote MCP server for Railway. Streamable HTTP at <code>/mcp</code>. Add this worker as a custom Grok connector — Railway’s hosted MCP cannot be attached directly.</p>
  <div class="row">
    <div><div class="k">MCP</div><div class="v"><code>/mcp</code></div></div>
    <div><div class="k">Auth</div><div class="v">${auth}</div></div>
    <div><div class="k">Railway token</div><div class="v">${railway}</div></div>
    <div><div class="k">Version</div><div class="v">${VERSION}</div></div>
  </div>
  <p>Health JSON lives at <code>/health</code>. Tool calls require a bearer token. The Railway credential is a Worker secret and is never returned.</p>
</main>
</body>
</html>`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (path === "/health") {
      return json({
        ok: true,
        name: NAME,
        version: VERSION,
        mcp: "/mcp",
        authConfigured: Boolean(env.MCP_AUTH_TOKEN),
        railwayConfigured: Boolean(env.RAILWAY_API_TOKEN),
        tools: makeTools(env).map((t) => t.name),
      });
    }

    if (path === "/" && request.method === "GET") {
      return html(landingPage(env));
    }

    if (path === "/mcp" || path === "/sse") {
      if (request.method === "GET" || request.method === "DELETE") {
        return json({ error: "stateless streamable HTTP — POST JSON-RPC to /mcp" }, 405, { Allow: "POST, OPTIONS" });
      }
      if (request.method !== "POST") {
        return text("Method Not Allowed", 405, { Allow: "POST, OPTIONS" });
      }

      const gate = authorized(request, env);
      if (!gate.ok) return json({ error: gate.error }, gate.status);

      let body;
      try {
        body = await request.json();
      } catch {
        return json({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }, 400);
      }

      const tools = makeTools(env);
      const extra = { "MCP-Protocol-Version": pickProtocol(request.headers.get("MCP-Protocol-Version")) };

      if (Array.isArray(body)) {
        const replies = [];
        for (const msg of body) {
          const r = await handleRpc(msg, env, tools);
          if (r) replies.push(r);
        }
        if (!replies.length) return new Response(null, { status: 202, headers: { ...CORS, ...extra } });
        return json(replies, 200, extra);
      }

      const reply = await handleRpc(body, env, tools);
      if (!reply) return new Response(null, { status: 202, headers: { ...CORS, ...extra } });
      return json(reply, 200, extra);
    }

    return json({ error: "not found", hint: "POST /mcp" }, 404);
  },
};

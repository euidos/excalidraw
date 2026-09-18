const int = (value, fallback) => {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export function loadConfig(env = process.env) {
  return {
    port: int(env.PORT, 3000),
    pg: {
      host: env.PG_HOST ?? "db",
      port: int(env.PG_PORT, 5432),
      user: env.PG_USER ?? "boards",
      database: env.PG_NAME ?? "boards",
      password: env.PG_PASSWORD ?? "",
    },
    accessAud: env.ACCESS_AUD ?? "",
    accessTeamDomain: env.ACCESS_TEAM_DOMAIN ?? "",
    maxSceneBytes: int(env.MAX_SCENE_BYTES, 20 * 1024 * 1024),
    maxFileBytes: int(env.MAX_FILE_BYTES, 4 * 1024 * 1024),
  };
}

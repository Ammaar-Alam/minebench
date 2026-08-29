export const dynamic = "force-static";

export async function GET() {
  return Response.json({
    applinks: {
      apps: [],
      details: [{
        appID: "VM6477A6M8.com.ammaaralam.minebench",
        components: [
          { "/": "/gallery/*", comment: "MineBench Gallery" },
          { "/": "/sandbox", comment: "MineBench Sandbox" },
          { "/": "/leaderboard/*", comment: "MineBench Leaderboard" },
        ],
      }],
    },
  }, {
    headers: {
      "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
    },
  });
}

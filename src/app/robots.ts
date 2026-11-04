import type { MetadataRoute } from "next";

// Jogo privado: bloqueia todos os robôs.
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", disallow: "/" } };
}

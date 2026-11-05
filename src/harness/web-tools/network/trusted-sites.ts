import { isIP } from "node:net";

/** 站点授权只匹配标准 HTTPS origin，不支持通配符、IP 或本机名称。 */
export function isTrustedHttpsOrigin(url: URL, origins: readonly string[]): boolean {
	return validSite(url) && origins.includes(url.origin);
}

export function validateTrustedHttpsOrigins(origins: readonly string[]): void {
	for (const origin of origins) {
		let url: URL;
		try { url = new URL(origin); } catch { throw new Error("Invalid trusted HTTPS origin."); }
		if (!validSite(url) || origin !== url.origin) throw new Error("Trusted sites require exact HTTPS origins on port 443, without paths, credentials, IPs or wildcards.");
	}
}

function validSite(url: URL): boolean {
	const host = url.hostname.replace(/^\[|\]$/gu, "");
	return url.protocol === "https:" && url.port === "" && url.username === "" && url.password === ""
		&& !host.includes("*") && host.includes(".") && !host.endsWith(".")
		&& host !== "localhost" && !host.endsWith(".localhost") && isIP(host) === 0;
}

import path from "node:path";
import { id, assets } from "pimoon:assets";
import { extractAssets } from "./extract-assets.ts";

const resourceDir = extractAssets(id, assets);
process.env.PIMOON_RESOURCE_DIR = resourceDir;
process.env.PI_PACKAGE_DIR = path.join(resourceDir, "pi");

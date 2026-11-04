// One package for both OpenCode plugin APIs: OpenCode 2 loads `setup` and OpenCode
// 1 loads `server`. The default export is the module's only export, as OpenCode 1
// would load a named one as a second plugin.
import { server } from "./v1/index.js";
import { setup } from "./v2/index.js";

export default { id: "agenthooksprotocol.adapter-opencode", setup, server };

const V = require("../web/valuation.js");
const cases = JSON.parse(require("fs").readFileSync(0, "utf8"));
const out = cases.map(({ c, hist, m, s, params, cfg }) => V.value(c, hist, m, s, params, cfg));
process.stdout.write(JSON.stringify(out));

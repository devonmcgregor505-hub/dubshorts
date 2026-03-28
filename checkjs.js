const fs = require("fs");
const html = fs.readFileSync("/Users/kanemcgregor/dubshorts/index.html", "utf8");
const scriptStart = html.indexOf("<script>");
const scriptEnd = html.lastIndexOf("</script>");
const js = html.slice(scriptStart + 8, scriptEnd);
const consts = {};
const re = /const (\w+)\s*=/g;
let m;
while ((m = re.exec(js)) !== null) {
  consts[m[1]] = (consts[m[1]] || 0) + 1;
}
const dups = Object.entries(consts).filter(([k,v]) => v > 1);
if (dups.length === 0) {
  console.log("No duplicates found");
} else {
  console.log("DUPLICATES:", dups.map(([k,v]) => k + "(x" + v + ")").join(", "));
}

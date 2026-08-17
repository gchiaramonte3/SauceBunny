import { webkit, chromium } from "playwright";
const cases = [
  "a&amp;b</textarea>tail",
  "Q&amp;A </textarea><img src=x>",
  "a&amp;b\r\nc",
  "ab\r\nc",
  "a&#13;b",
  "&amp;#39;",
  "&#47;etc&#47;passwd &amp;",
  "x&#0;y",
  "\n&amp;lead",
  "&#x1F600;&amp;",
  "Tom &amp Jerry",
  "&notit; &amp;",
  "a&amp;b</TEXTAREA >tail",
];
for (const [name, type] of [["webkit", webkit], ["chromium", chromium]]) {
  const b = await type.launch();
  const p = await b.newPage();
  await p.setContent("<body>");
  const out = await p.evaluate((cases) => cases.map((s) => {
    const ta = document.createElement("textarea");
    ta.innerHTML = s;
    return [s, ta.value];
  }), cases);
  console.log("=== " + name);
  for (const [i, o] of out) console.log(JSON.stringify(i), "=>", JSON.stringify(o));
  await b.close();
}

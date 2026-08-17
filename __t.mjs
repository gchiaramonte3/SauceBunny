import { JSDOM } from "jsdom";
const dom = new JSDOM("<!doctype html><body>");
const document = dom.window.document;
function dec(s){
  if (!s) return "";
  if (!s.includes("&")) return s;
  const ta = document.createElement("textarea");
  ta.innerHTML = s;
  return ta.value;
}
const cases = [
  "a&amp;b</textarea>tail",
  "Q&amp;A </textarea><img src=x>",
  "a&amp;b\r\nc",
  "ab\r\nc",
  "a&#13;b",
  "&amp;#39;",
  "&#47;etc&#47;passwd &amp;",
  "&sol;tmp&amp;",
  "x&#0;y",
  "\n&amp;lead",
  "&#x1F600;&amp;",
  "&amp;&lt;script&gt;",
  "Tom &amp Jerry",
  "&notit; &amp;",
  "a&amp;b</TEXTAREA >tail",
  "a&amp;b</textarea",
];
for (const c of cases) console.log(JSON.stringify(c), "=>", JSON.stringify(dec(c)));

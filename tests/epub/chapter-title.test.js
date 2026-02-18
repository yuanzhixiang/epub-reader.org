import { describe, expect, it } from "vitest";
import { removeDuplicateLeadingHeading } from "../../src/epub/chapter-title.js";

describe("chapter title dedupe", function () {
  it("removes a single leading heading when it exactly matches the display title", function () {
    var html = "<h1>Chapter 3: Customer Discovery</h1><p>Body text.</p>";
    var out = removeDuplicateLeadingHeading(html, "Chapter 3: Customer Discovery");
    var doc = new DOMParser().parseFromString("<!doctype html><html><body>" + out + "</body></html>", "text/html");

    expect(doc.body.querySelector("h1")).toBeNull();
    expect(doc.body.firstElementChild && doc.body.firstElementChild.tagName.toLowerCase()).toBe("p");
  });

  it("removes leading chapter marker + subtitle when their merged text matches display title", function () {
    var html = "" +
      "<h1 class=\"chapter\">CHAPTER 1</h1>" +
      "<h1 class=\"chapter2\">The Path to Disaster: The Product Development Model</h1>" +
      "<div class=\"blockquote\"><p>Quote</p></div>";
    var out = removeDuplicateLeadingHeading(html, "Chapter 1: The Path To Disaster: The Product Development Model");
    var doc = new DOMParser().parseFromString("<!doctype html><html><body>" + out + "</body></html>", "text/html");

    expect(doc.body.querySelector("h1.chapter")).toBeNull();
    expect(doc.body.querySelector("h1.chapter2")).toBeNull();
    expect(doc.body.firstElementChild && doc.body.firstElementChild.classList.contains("blockquote")).toBe(true);
  });

  it("keeps a leading media banner but removes following duplicated chapter headings", function () {
    var html = "" +
      "<p class=\"center20\" id=\"chap5\"><a id=\"page157\"></a><img alt=\"image\" src=\"images/TopChap5.jpg\"></p>" +
      "<h1 class=\"chapter\">CHAPTER 5</h1>" +
      "<h1 class=\"chapter2\">Customer Creation</h1>" +
      "<div class=\"blockquote\"><p>Quote</p></div>";
    var out = removeDuplicateLeadingHeading(html, "Chapter 5: Customer Creation");
    var doc = new DOMParser().parseFromString("<!doctype html><html><body>" + out + "</body></html>", "text/html");

    expect(doc.body.querySelector("p#chap5 img")).not.toBeNull();
    expect(doc.body.querySelector("h1.chapter")).toBeNull();
    expect(doc.body.querySelector("h1.chapter2")).toBeNull();
    expect(doc.body.firstElementChild && doc.body.firstElementChild.id).toBe("chap5");
  });

  it("keeps headings when display title does not match", function () {
    var html = "<h1 class=\"chapter\">CHAPTER 1</h1><h1 class=\"chapter2\">The Path to Disaster</h1><p>Body</p>";
    var out = removeDuplicateLeadingHeading(html, "Chapter 2");
    var doc = new DOMParser().parseFromString("<!doctype html><html><body>" + out + "</body></html>", "text/html");

    expect(doc.body.querySelector("h1.chapter")).not.toBeNull();
    expect(doc.body.querySelector("h1.chapter2")).not.toBeNull();
  });
});

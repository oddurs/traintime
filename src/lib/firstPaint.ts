/**
 * What the first paint needs to know about this visitor, decided before React runs.
 *
 * The page is prerendered once for everybody, and React only learns what this browser has stored
 * when it hydrates — a second or more into a slow load. Anything stored that changes the layout
 * was drawn wrong until then and moved when it was corrected: the legend was in the HTML for a
 * returning visitor who had dismissed it, and vanished from under them at hydration; saved
 * stations, the first thing a commuter's sheet shows, arrived at hydration and pushed it taller.
 * A few bytes in the head, read before anything is drawn, set what the stylesheet keys on.
 */
export const LEGEND_KEY = "tt.legend.dismissed";
export const PLACES_KEY = "tt.places.v1";
/** How tall the saved list was last drawn, per layout, so the first paint can keep its place. */
export const SAVED_HEIGHT_KEY = "tt.saved.h";
/** The same breakpoint as the stylesheet's phone layout. */
export const PHONE_QUERY = "(max-width: 640px)";

export const FIRST_PAINT_SCRIPT = `try{var d=document.documentElement,s=localStorage;`
  + `if(s.getItem(${JSON.stringify(LEGEND_KEY)})==="1")d.classList.add("legend-dismissed");`
  + `var p=JSON.parse(s.getItem(${JSON.stringify(PLACES_KEY)})||"[]"),h=JSON.parse(s.getItem(${JSON.stringify(SAVED_HEIGHT_KEY)})||"{}")`
  + `[matchMedia(${JSON.stringify(PHONE_QUERY)}).matches?"phone":"wide"];`
  + `if(p.length&&h>0){d.classList.add("has-saved");d.style.setProperty("--saved-h",h+"px")}}catch(e){}`;

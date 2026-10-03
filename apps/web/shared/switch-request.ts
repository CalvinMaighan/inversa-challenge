/** "select the carp", "switch to lionfish", "go to the python app": a request to move to another of the three apps, not a question. */
export const SWITCH_REQUEST = /\b(switch|change|go|select|pick|choose|open|take me|move|jump)\b[^.?!]{0,40}\b(carp|lionfish|python|pythons|burmese|asian carp|app|species)\b/i;

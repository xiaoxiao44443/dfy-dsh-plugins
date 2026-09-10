# DFY DSH Appearance

Adds an **外观** page to the Harness settings sidebar. It preserves every visible
Assistant text output and collapses the context/reasoning/tool segment immediately
before that output behind its own disclosure as soon as the response starts,
including intermediate responses during an active turn. Unfinished steps after
the latest response stay visible, and manually expanded segments stay expanded
when later responses arrive. It also adjusts the chat font size and line-height ratio
without changing the sidebar, settings UI, editor, or persisted transcript.

The process-group adapter observes the stable `data-chat-flow-kind` attributes
and turn boundaries, without waiting for a completed turn's tail. It never edits
conversation data; disabling or unloading the plugin removes every DOM marker.
Media tool rows belong to the same per-output segment, so screenshots and visual
analysis collapse with the process that produced the following text and return in
their original position when that segment is expanded.

On DSH 0.1.2, enabling the plugin's process folding switches the built-in
`ui-chat.transcriptView` from `Compact` to `Normal`, then keeps its finer
per-response disclosures. This also runs once at activation when process folding
is already enabled. If the user later explicitly selects `Compact`, the plugin
yields its own disclosure layer to avoid double folding until its folding switch
is turned off and on again. DSH 0.1.1-rc.2 has no built-in Turn disclosure and
continues through the original capability-detected path.

The desktop context menu exposes local `.html`, `.htm`, and `.xhtml` file links
to both the built-in and default browser through their original `file:` URL.
Clicking the file or selecting **打开文件** still invokes the official file
preview. Published visualization links keep their existing HTTP URL behavior.
An unrelated visualization elsewhere in the conversation cannot replace an
ordinary file's URL. Source-less visualization metadata is used only inside a
visualization container.
Browser actions require a desktop build with local HTML support; network shares
retain their ordinary file actions.

# DFY DSH Appearance

Adds an **外观** page to the Harness settings sidebar for chat font size,
response line height, and process line height. Process disclosure follows
Harness's built-in display mode; the former per-response folding option
has been removed and existing values are ignored.

Plugin-generated images and visualizations remain beside their related
response. Typography and artifact placement do not change conversation data.

The desktop context menu exposes local `.html`, `.htm`, and `.xhtml` file links
to both the built-in and default browser through their original `file:` URL.
Clicking the file or selecting **打开文件** still invokes the official file
preview. Published visualization links keep their existing HTTP URL behavior.
An unrelated visualization elsewhere in the conversation cannot replace an
ordinary file's URL. Source-less visualization metadata is used only inside a
visualization container.
Browser actions require a desktop build with local HTML support; network shares
retain their ordinary file actions.

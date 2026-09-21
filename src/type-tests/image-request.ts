/** Compile-time image API regressions, checked by the SDK declaration build. */
import "../../v1";

type ImageRequest = Parameters<Window["maypop"]["ai"]["image"]>[0];
const accepts = (request: ImageRequest) => request;

accepts({ prompt: "a fox" });
accepts({ prompt: "a fox", size: "3K" });
accepts({ prompt: "a fox", tier: "fast", size: "4K", n: 2 });
accepts({ prompt: "a fox", tier: "quality" });
accepts({ prompt: "a fox", tier: "quality", size: "2K", n: 1 });
accepts({ prompt: "a fox", tier: "quality", size: "2560x1440" });
accepts({ prompt: "a fox", tier: "quality", image: ["https://example.com/ref.jpg"] });

// @ts-expect-error Pro has no 3K preset.
accepts({ prompt: "a fox", tier: "quality", size: "3K" });
// @ts-expect-error Pro has no 4K preset.
accepts({ prompt: "a fox", tier: "quality", size: "4K" });
// @ts-expect-error An arbitrary string must not bypass the tier's size restriction.
accepts({ prompt: "a fox", tier: "quality", size: "anything" });
// @ts-expect-error Quality supports one output image.
accepts({ prompt: "a fox", tier: "quality", n: 2 });
// @ts-expect-error Quality does not support sequential generation.
accepts({ prompt: "a fox", tier: "quality", sequential_image_generation: "auto" });
// @ts-expect-error Quality does not support batches through provider options.
accepts({ prompt: "a fox", tier: "quality", sequential_image_generation_options: { max_images: 2 } });

// @ts-expect-error Small presets are runtime compatibility only, not authoring options.
accepts({ prompt: "a fox", size: "1K" });
// @ts-expect-error Pro's legacy 1.5K preset is runtime compatibility only.
accepts({ prompt: "a fox", tier: "quality", size: "1.5K" });

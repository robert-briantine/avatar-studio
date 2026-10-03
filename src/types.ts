export type ComfyImageRef = {
  filename: string;
  subfolder?: string;
  type?: string;
};

export type GenerateOptions = {
  scenePrompt: string;
  text: string;
  textMode: "integrated" | "exact";
  width: number;
  height: number;
  seed: number;
  textPosition: "top" | "center" | "bottom";
  fontSize: number;
};

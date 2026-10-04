import logging

from .reference import build_handoff_sequence, restore_reference


class DGXRestoreWanReference:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"image": ("IMAGE",), "original": ("IMAGE",)}}

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "restore"
    CATEGORY = "DGX Avatar/video"
    DESCRIPTION = "Reconstruit la pose de raccord avec les détails de l'avatar original."

    def restore(self, image, original):
        import torch
        import comfy.utils
        # Match the exact center framing used by WanSoundImageToVideo, including
        # images imported with the Original framing option and portrait sources.
        reference = comfy.utils.common_upscale(
            original[:1, :, :, :3].movedim(-1, 1), image.shape[2], image.shape[1], "bilinear", "center"
        ).movedim(1, -1)
        restored, diagnostics = restore_reference(
            reference[0].detach().float().cpu().numpy(),
            image[0, :, :, :3].detach().float().cpu().numpy(),
        )
        logging.info("[DGX reference] %s", diagnostics)
        return (torch.from_numpy(restored).unsqueeze(0).to(device=image.device, dtype=image.dtype),)


class DGXPrepareWanHandoff:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"image": ("IMAGE",), "original": ("IMAGE",)}}

    RETURN_TYPES = ("IMAGE", "IMAGE")
    RETURN_NAMES = ("control_video", "restored_motion")
    FUNCTION = "prepare"
    CATEGORY = "DGX Avatar/video"
    DESCRIPTION = "Nettoie la dernière pose avec les pixels source puis verrouille cette base pendant le raccord Wan."

    def prepare(self, image, original):
        import torch
        import comfy.utils
        reference = comfy.utils.common_upscale(
            original[:1, :, :, :3].movedim(-1, 1), image.shape[2], image.shape[1], "bilinear", "center"
        ).movedim(1, -1)
        control, prepared, diagnostics = build_handoff_sequence(
            reference[0].detach().float().cpu().numpy(),
            image[0, :, :, :3].detach().float().cpu().numpy(),
        )
        logging.info("[DGX handoff] %s", diagnostics)
        return (
            torch.from_numpy(control).to(device=image.device, dtype=image.dtype),
            torch.from_numpy(prepared).unsqueeze(0).to(device=image.device, dtype=image.dtype),
        )


NODE_CLASS_MAPPINGS = {
    "DGXRestoreWanReference": DGXRestoreWanReference,
    "DGXPrepareWanHandoff": DGXPrepareWanHandoff,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "DGXRestoreWanReference": "DGX — Restaurer la référence Wan",
    "DGXPrepareWanHandoff": "DGX — Préparer la reprise Wan",
}

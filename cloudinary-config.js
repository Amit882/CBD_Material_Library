// cloudinary-config.js
// ------------------------------------------------------------------
// Free image hosting (no credit card needed), used instead of Firebase Storage.
//
// 1. Go to https://cloudinary.com/users/register/free → create a free account
// 2. On your Dashboard, copy the "Cloud name" shown at the top → paste it below
// 3. Go to Settings (gear icon) → Upload → scroll to "Upload presets" → "Add upload preset"
//      - Set "Signing Mode" to UNSIGNED (this is what allows the browser to upload
//        directly without exposing any secret key)
//      - Give it a name (e.g. "cbd_material_library") → Save
// 4. Paste that preset name below too
// ------------------------------------------------------------------

export const cloudinaryConfig = {
  cloudName: "pcenvbp9",
  uploadPreset: "CBD Material Library",
};

export const isCloudinaryConfigured =
  cloudinaryConfig.cloudName !== "YOUR_CLOUD_NAME" &&
  cloudinaryConfig.uploadPreset !== "YOUR_UPLOAD_PRESET";

// Uploads a File object to Cloudinary and returns the public image URL.
export async function uploadImageToCloudinary(file){
  const formData = new FormData();
  formData.append('file', file);
  formData.append('upload_preset', cloudinaryConfig.uploadPreset);

  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${cloudinaryConfig.cloudName}/image/upload`,
    { method: 'POST', body: formData }
  );

  if(!res.ok){
    const errText = await res.text();
    throw new Error(`Cloudinary upload failed: ${errText}`);
  }
  const data = await res.json();
  return data.secure_url;
}

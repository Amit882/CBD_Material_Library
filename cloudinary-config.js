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

  // ----------------------------------------------------------
  // SECURITY: validate the file before sending it to Cloudinary
  // ----------------------------------------------------------

  if(!(file instanceof File)){
    throw new Error('Invalid image file.');
  }


  // Maximum upload size: 5 MB
  const MAX_SIZE = 5 * 1024 * 1024;

  if(file.size <= 0){
    throw new Error('The selected image is empty.');
  }

  if(file.size > MAX_SIZE){
    throw new Error('Image is too large. Maximum allowed size is 5 MB.');
  }


  // Only allow actual browser-reported image MIME types
  const allowedTypes = new Set([
    'image/jpeg',
    'image/png',
    'image/webp'
  ]);

  if(!allowedTypes.has(file.type)){
    throw new Error(
      'Invalid image type. Please upload JPG, PNG, or WebP.'
    );
  }


  // Also check the filename extension
  const fileName =
    String(file.name || '').toLowerCase();

  const allowedExtensions = [
    '.jpg',
    '.jpeg',
    '.png',
    '.webp'
  ];

  if(
    !allowedExtensions.some(ext =>
      fileName.endsWith(ext)
    )
  ){
    throw new Error(
      'Invalid image extension. Please use JPG, PNG, or WebP.'
    );
  }


  const formData = new FormData();

  formData.append(
    'file',
    file,
    file.name
  );

  formData.append(
    'upload_preset',
    cloudinaryConfig.uploadPreset
  );


  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudinaryConfig.cloudName)}/image/upload`,
    {
      method: 'POST',
      body: formData
    }
  );


  if(!res.ok){

    let message =
      'Cloudinary upload failed.';

    try{

      const errorData =
        await res.json();

      if(
        errorData?.error?.message
      ){
        message =
          errorData.error.message;
      }

    }catch{
      // Keep generic message if Cloudinary
      // doesn't return JSON.
    }

    throw new Error(message);
  }


  const data =
    await res.json();


  if(
    !data.secure_url ||
    typeof data.secure_url !== 'string'
  ){
    throw new Error(
      'Cloudinary returned an invalid image URL.'
    );
  }


  return data.secure_url;
}

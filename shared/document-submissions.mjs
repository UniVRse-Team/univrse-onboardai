// Edit these labels when HR confirms its document categories.
export const documentTypes = [
  'Identification Document',
  'Employment Documents',
  'Certificates and Qualifications',
  'Leave Supporting Documents',
  'Medical Certificate',
  'Other',
];
export const reviewStatuses = ['Pending Review', 'Under Review', 'Approved', 'Rejected'];
export const maxFileBytes = 25 * 1024 * 1024;
export const fileTypes = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
};
export const fileExtension = (name) => String(name).split('.').pop().toLowerCase();
export const fileSize = (bytes) =>
  bytes < 1024 * 1024
    ? `${Math.ceil(bytes / 1024)} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
export function fileProblem(file) {
  if (!file || !file.size) return 'Choose a non-empty file.';
  if (file.size > maxFileBytes) return 'Your file exceeds 25 MB. Choose a smaller file.';
  if (!fileTypes[fileExtension(file.name)]) return 'Choose a PDF, DOCX, JPG or PNG file.';
  return '';
}

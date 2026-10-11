/**
 * Form kit: react-hook-form + zodResolver + shadcn Field components.
 *
 * @example
 *   const form = useForm<z.input<typeof schema>, unknown, z.output<typeof schema>>({
 *     resolver: zodResolver(schema),
 *     defaultValues: { name: "", priceMinor: "" },
 *   });
 *   useUnsavedChangesWarning(form);
 *   <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
 *     <FieldGroup>
 *       <FormTextField control={form.control} name="name" label="Name" required />
 *       <FormAmountField control={form.control} name="priceMinor" label="Price" currencyCode="INR" />
 *     </FieldGroup>
 *   </form>
 */
export {
  FormItem,
  RequiredMark,
  describedBy,
  type BaseFormFieldProps,
  type AnyFormContext,
} from './form-item';
export { FormTextField, type FormTextFieldProps } from './form-text-field';
export { FormTextarea, type FormTextareaProps } from './form-textarea';
export { FormSelect, type FormSelectProps, type SelectOption } from './form-select';
export { FormSwitch, type FormSwitchProps } from './form-switch';
export { FormDateTimeField, type FormDateTimeFieldProps } from './form-date-time-field';
export { FormAmountField, type FormAmountFieldProps } from './form-amount-field';
export { useUnsavedChangesWarning } from './use-unsaved-changes-warning';
export { applyApiFieldErrors, type ApiErrorFormTarget } from './apply-api-errors';
